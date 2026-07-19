#!/usr/bin/env -S npx tsx
/**
 * Phase B backfill driver — pushes the historical corpus
 * ("Amitabh Fire Safety BOQ Data/" at the repo root: 142 PDF + 3 XLSX) through
 * the ingestion pipeline. Three modes, one per stage of the rollout:
 *
 *   --upload   Upload the local corpus to gs://$INGEST_GCS_BUCKET/corpus/<filename>
 *              (@google-cloud/storage; ADC credentials). Files already present
 *              with a matching byte size are skipped, so re-runs are cheap.
 *
 *   --remote   Drive a DEPLOYED worker: list gs://$INGEST_GCS_BUCKET/corpus/*,
 *              POST {sourceUri} to $WORKER_URL/tasks/ingest per file,
 *              authenticating with an OIDC identity token minted by
 *              google-auth-library (GoogleAuth.getIdTokenClient, audience =
 *              $WORKER_URL — the same IAM layer Cloud Run enforces). Runs
 *              --concurrency requests in parallel (default 3), retries each
 *              file once on a 5xx.
 *
 *   --local    The eval-iteration path: iterate the local corpus dir directly
 *              (file:// uris) with an IN-PROCESS pipeline — createDb()
 *              (+ migrations on PGlite) + createStorage + a Gemini model from
 *              GOOGLE_GENERATIVE_AI_API_KEY (PDFs are SKIPPED with a warning
 *              when unset) + createEmbedder. Sequential, so a single PGlite
 *              never sees concurrent writers.
 *
 * Shared flags:
 *   --dry-run          List what would be done (upload/POST/ingest) and exit.
 *   --only <substr>    Only files whose name contains <substr> (case-insens.).
 *   --force            Pass force:true — re-ingest documents already DONE.
 *   --resume           Skip documents already DONE (remote: via the worker's
 *                      GET /tasks/ingest/status; local: via the local db).
 *   --concurrency <n>  Parallel requests in --remote mode (default 3).
 *
 * Every mode prints a per-file result table and a failures summary, and exits
 * 1 if any file failed (skips from --resume are not failures).
 *
 * Env: INGEST_GCS_BUCKET (upload/remote), WORKER_URL (remote),
 *      GOOGLE_GENERATIVE_AI_API_KEY + storage/db env (local — see .env.example).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEmbedder, createIngestModelFromEnv } from "@pebble/ai";
import { createDb, getSourceDocumentByUri, migrateDb } from "@pebble/db";
import pLimit from "p-limit";
import { parseCorpusFilename } from "../src/ingest/filename";
import { ingestSourceDocument } from "../src/ingest/pipeline";
import type { IngestReport } from "../src/ingest/pipeline";
import { createStorage } from "../src/storage";

const CORPUS_DIR_NAME = "Amitabh Fire Safety BOQ Data";
const CORPUS_PREFIX = "corpus/";

// ─── CLI parsing ────────────────────────────────────────────────────────────

interface CliArgs {
  mode: "upload" | "remote" | "local";
  dryRun: boolean;
  force: boolean;
  resume: boolean;
  only: string | null;
  concurrency: number;
}

function usage(): never {
  console.error(
    "Usage: backfill-ingest.ts (--upload | --remote | --local) " +
      "[--dry-run] [--force] [--resume] [--only <substr>] [--concurrency <n>]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): CliArgs {
  let mode: CliArgs["mode"] | null = null;
  const args: Omit<CliArgs, "mode"> = { dryRun: false, force: false, resume: false, only: null, concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--upload":
      case "--remote":
      case "--local":
        if (mode !== null) usage();
        mode = a.slice(2) as CliArgs["mode"];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--resume":
        args.resume = true;
        break;
      case "--only":
        args.only = argv[++i] ?? usage();
        break;
      case "--concurrency": {
        const n = Number(argv[++i]);
        if (!Number.isInteger(n) || n < 1) usage();
        args.concurrency = n;
        break;
      }
      default:
        usage();
    }
  }
  if (mode === null) usage();
  return { mode, ...args };
}

// ─── Corpus discovery ───────────────────────────────────────────────────────

/** Walk up from `startDir` for the workspace root marker (mirrors packages/ai/eval). */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(join(dir, "pnpm-workspace.yaml"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(`Could not find repo root (pnpm-workspace.yaml) walking up from ${startDir}`);
}

function listCorpusFilenames(corpusDir: string): string[] {
  return readdirSync(corpusDir)
    .filter((f) => /\.(pdf|xlsx)$/i.test(f))
    .sort((a, b) => a.localeCompare(b));
}

function applyOnly(files: string[], only: string | null): string[] {
  if (!only) return files;
  const needle = only.toLowerCase();
  return files.filter((f) => f.toLowerCase().includes(needle));
}

// ─── Table printing ─────────────────────────────────────────────────────────

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)));
  const line = (cells: string[]): string => cells.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join("  ");
  console.log(line(headers));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(r));
}

interface FileResult {
  filename: string;
  outcome: string; // DONE / SKIPPED / FAILED / UPLOADED / ...
  detail: string;
  failed: boolean;
}

function reportResults(results: FileResult[]): void {
  printTable(
    ["#", "file", "outcome", "detail"],
    results.map((r, i) => [String(i + 1), r.filename, r.outcome, r.detail]),
  );
  const failures = results.filter((r) => r.failed);
  console.log(
    `\n${results.length} file(s): ${results.filter((r) => !r.failed).length} ok, ${failures.length} failed.`,
  );
  if (failures.length > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f.filename}: ${f.detail}`);
    process.exitCode = 1;
  }
}

function summarizeReport(r: IngestReport): string {
  const warn = r.warnings.length > 0 ? ` warn=${r.warnings.length}` : "";
  return `lines=${r.linesStaged} chunks=${r.chunksIndexed} pages=${r.pagesProcessed} cost=$${r.costUsd.toFixed(4)}${warn}`;
}

// ─── --upload ───────────────────────────────────────────────────────────────

async function runUpload(args: CliArgs, corpusDir: string): Promise<void> {
  const bucketName = process.env.INGEST_GCS_BUCKET;
  if (!bucketName) throw new Error("--upload requires INGEST_GCS_BUCKET");
  const files = applyOnly(listCorpusFilenames(corpusDir), args.only);

  if (args.dryRun) {
    printTable(
      ["#", "file", "→ destination"],
      files.map((f, i) => [String(i + 1), f, `gs://${bucketName}/${CORPUS_PREFIX}${f}`]),
    );
    console.log(`\n${files.length} file(s) would be uploaded (size-matched files skipped).`);
    return;
  }

  const { Storage } = await import("@google-cloud/storage");
  const bucket = new Storage().bucket(bucketName);
  const results: FileResult[] = [];
  for (const filename of files) {
    const localPath = join(corpusDir, filename);
    const key = `${CORPUS_PREFIX}${filename}`;
    const localSize = statSync(localPath).size;
    try {
      const file = bucket.file(key);
      const [exists] = await file.exists();
      if (exists) {
        const [meta] = await file.getMetadata();
        if (Number(meta.size) === localSize) {
          results.push({ filename, outcome: "SKIPPED", detail: `already uploaded (${localSize} bytes)`, failed: false });
          continue;
        }
      }
      await bucket.upload(localPath, { destination: key, resumable: false });
      results.push({ filename, outcome: "UPLOADED", detail: `${localSize} bytes`, failed: false });
    } catch (err) {
      results.push({ filename, outcome: "FAILED", detail: (err as Error).message, failed: true });
    }
  }
  reportResults(results);
}

// ─── --remote ───────────────────────────────────────────────────────────────

interface StatusDoc {
  storageUri: string;
  status: string;
}

async function runRemote(args: CliArgs, corpusDir: string | null): Promise<void> {
  const bucketName = process.env.INGEST_GCS_BUCKET;
  const workerUrl = process.env.WORKER_URL?.replace(/\/$/, "");
  if (!bucketName) throw new Error("--remote requires INGEST_GCS_BUCKET");
  if (!workerUrl) throw new Error("--remote requires WORKER_URL");

  // Build the object list from the LOCAL corpus dir when present (the worker
  // reads GCS under its own service account, so the driver never needs bucket
  // access itself — this keeps --remote independent of local ADC state).
  // Falls back to a GCS listing when no local corpus exists (e.g. CI).
  let objectNames: string[];
  if (corpusDir !== null) {
    objectNames = listCorpusFilenames(corpusDir).map((f) => `${CORPUS_PREFIX}${f}`);
  } else {
    const { Storage } = await import("@google-cloud/storage");
    const [gcsFiles] = await new Storage().bucket(bucketName).getFiles({ prefix: CORPUS_PREFIX });
    objectNames = gcsFiles.map((f) => f.name).filter((n) => n.length > CORPUS_PREFIX.length);
  }
  const uris = applyOnly(objectNames, args.only).map((name) => `gs://${bucketName}/${name}`);

  if (args.dryRun) {
    printTable(
      ["#", "sourceUri", "→ endpoint"],
      uris.map((u, i) => [String(i + 1), u, `${workerUrl}/tasks/ingest`]),
    );
    console.log(`\n${uris.length} document(s) would be posted (concurrency ${args.concurrency}).`);
    return;
  }

  // OIDC identity token for the worker (Cloud Run IAM). Two lanes:
  //  - WORKER_TOKEN_FROM_GCLOUD=1: mint a USER identity token via the gcloud
  //    CLI (works for any signed-in invoker principal — no service-account
  //    credentials needed locally), cached and re-minted every 45 min so runs
  //    longer than a token's 1h TTL survive.
  //  - default: google-auth-library ADC (service-account contexts, CI).
  let authHeader: () => Promise<string>;
  if (process.env.WORKER_TOKEN_FROM_GCLOUD === "1") {
    const { execFileSync } = await import("node:child_process");
    let cached: { token: string; mintedAt: number } | null = null;
    authHeader = async () => {
      if (!cached || Date.now() - cached.mintedAt > 45 * 60 * 1000) {
        const token = execFileSync("gcloud", ["auth", "print-identity-token"], {
          encoding: "utf8",
        }).trim();
        cached = { token, mintedAt: Date.now() };
      }
      return `Bearer ${cached.token}`;
    };
  } else {
    const { GoogleAuth } = await import("google-auth-library");
    const client = await new GoogleAuth().getIdTokenClient(workerUrl);
    authHeader = async () => {
      const headers = await client.getRequestHeaders();
      const bearer =
        headers instanceof Headers
          ? headers.get("authorization")
          : (headers as Record<string, string>)["Authorization"];
      if (!bearer) throw new Error("could not mint an identity token for the worker");
      return bearer;
    };
  }

  const request = async <T>(url: string, init: { method: string; body?: string }): Promise<T> => {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        authorization: await authHeader(),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(900_000),
    });
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${data?.error ?? ""}`);
      (err as unknown as { response: { status: number; data: unknown } }).response = {
        status: res.status,
        data,
      };
      throw err;
    }
    return data as T;
  };

  let doneUris = new Set<string>();
  if (args.resume) {
    const statusRes = await request<{ documents: StatusDoc[] }>(
      `${workerUrl}/tasks/ingest/status`,
      { method: "GET" },
    );
    doneUris = new Set(
      (statusRes.documents ?? []).filter((d) => d.status === "DONE").map((d) => d.storageUri),
    );
  }

  const postOnce = async (sourceUri: string): Promise<IngestReport> => {
    return request<IngestReport>(`${workerUrl}/tasks/ingest`, {
      method: "POST",
      body: JSON.stringify({ sourceUri, ...(args.force ? { force: true } : {}) }),
    });
  };

  const limit = pLimit(args.concurrency);
  const results = await Promise.all(
    uris.map((uri) =>
      limit(async (): Promise<FileResult> => {
        const filename = uri.split("/").pop() ?? uri;
        if (doneUris.has(uri)) {
          return { filename, outcome: "SKIPPED", detail: "already DONE (--resume)", failed: false };
        }
        try {
          let report: IngestReport;
          try {
            report = await postOnce(uri);
          } catch (err) {
            const status = (err as { response?: { status?: number } }).response?.status;
            if (status !== undefined && status >= 500) {
              report = await postOnce(uri); // one retry on a 5xx
            } else {
              throw err;
            }
          }
          return { filename, outcome: report.status, detail: summarizeReport(report), failed: report.status !== "DONE" };
        } catch (err) {
          const resp = (err as { response?: { status?: number; data?: { error?: string } } }).response;
          const detail = resp ? `HTTP ${resp.status}: ${resp.data?.error ?? ""}` : (err as Error).message;
          return { filename, outcome: "FAILED", detail, failed: true };
        }
      }),
    ),
  );
  reportResults(results);
}

// ─── --local ────────────────────────────────────────────────────────────────

async function runLocal(args: CliArgs, corpusDir: string): Promise<void> {
  const files = applyOnly(listCorpusFilenames(corpusDir), args.only);

  if (args.dryRun) {
    printTable(
      ["#", "file", "ref", "rev", "date", "type"],
      files.map((f, i) => {
        const p = parseCorpusFilename(f);
        return [
          String(i + 1),
          f,
          p.fileRef ?? "—",
          p.revision ?? "—",
          p.docDate ? p.docDate.toISOString().slice(0, 10) : "—",
          p.docType,
        ];
      }),
    );
    console.log(`\n${files.length} corpus file(s) would be ingested locally.`);
    return;
  }

  const handle = await createDb();
  if (handle.kind === "pglite") await migrateDb(handle);
  const model = createIngestModelFromEnv(process.env);
  if (model === null) {
    console.warn(
      "GOOGLE_GENERATIVE_AI_API_KEY is not set — PDFs will be SKIPPED (XLSX still ingest deterministically).",
    );
  }
  const deps = {
    db: handle.db,
    storage: createStorage(process.env),
    ai: { model, embedder: createEmbedder(process.env) },
  };

  const results: FileResult[] = [];
  try {
    // Sequential on purpose: a single PGlite must not see concurrent writers.
    for (const filename of files) {
      const sourceUri = pathToFileURL(join(corpusDir, filename)).href;
      if (model === null && /\.pdf$/i.test(filename)) {
        results.push({ filename, outcome: "SKIPPED", detail: "no extraction model configured", failed: false });
        continue;
      }
      if (args.resume) {
        const existing = await getSourceDocumentByUri(handle.db, sourceUri);
        if (existing?.status === "DONE") {
          results.push({ filename, outcome: "SKIPPED", detail: "already DONE (--resume)", failed: false });
          continue;
        }
      }
      try {
        const report = await ingestSourceDocument(deps, { sourceUri, force: args.force });
        results.push({
          filename,
          outcome: report.status,
          detail: summarizeReport(report),
          failed: report.status !== "DONE",
        });
      } catch (err) {
        results.push({ filename, outcome: "FAILED", detail: (err as Error).message, failed: true });
      }
    }
  } finally {
    await handle.close();
  }
  reportResults(results);
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const corpusDir = join(repoRoot, CORPUS_DIR_NAME);

  if (args.mode === "upload") await runUpload(args, corpusDir);
  else if (args.mode === "remote")
    await runRemote(args, existsSync(corpusDir) ? corpusDir : null);
  else await runLocal(args, corpusDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
