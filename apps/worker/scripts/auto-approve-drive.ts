#!/usr/bin/env -S npx tsx
/**
 * Phase B Gemini FULL AUTO-APPROVE driver — walks the PROPOSED staged-record
 * queue in batches, letting Gemini verify + commit/reject each row until the
 * queue is drained (or `--max-batches` is hit). Two modes:
 *
 *   --remote (default)  Drive a DEPLOYED worker: POST {limit, dryRun,
 *                       concurrency} to $WORKER_URL/tasks/auto-approve, looping
 *                       until the returned remainingProposed hits 0 (or a batch
 *                       resolves nothing, or --max-batches). Auth is the same
 *                       Cloud Run OIDC lane as backfill-ingest: a gcloud USER
 *                       identity token when WORKER_TOKEN_FROM_GCLOUD=1 (re-minted
 *                       every 45 min), else google-auth-library ADC. Retries a
 *                       batch once on a 5xx.
 *
 *   --local             Dev/eval path: build in-process deps (createDb + a Gemini
 *                       model from createGeminiModelFromEnv + createEmbedder) and
 *                       call autoApproveBatch directly against the local db. A
 *                       fresh PGlite is empty, so `--demo <n>` seeds it (masters
 *                       + n synthetic PROPOSED rows) and swaps in an OFFLINE stub
 *                       verifier so `--local --dry-run --demo` runs with no cloud
 *                       credentials at all.
 *
 * Flags:
 *   --local            In-process mode (default is --remote).
 *   --dry-run          Verify + report the would-be split, write nothing. Runs a
 *                      single batch (a dry run never changes remainingProposed).
 *   --limit <n>        PROPOSED rows per batch/request (default 200).
 *   --max-batches <n>  Cap on batches (default 30).
 *   --concurrency <n>  Parallel verifications per batch (default 4).
 *   --worker-url <u>   Override $WORKER_URL (remote).
 *   --demo <n>         Local only: seed n synthetic PROPOSED rows + offline stub.
 *
 * Exit 0 when the queue is drained (or the dry run / demo completes); 1 on a hard
 * request failure.
 *
 * Env: WORKER_URL (remote), WORKER_TOKEN_FROM_GCLOUD, GOOGLE_* / PEBBLE_* (local
 * model + embedder — see .env.example).
 */
import type { LanguageModel } from "@pebble/ai";
import { createEmbedder, createGeminiModelFromEnv, modelConfigFromEnv } from "@pebble/ai";
import {
  createDb,
  insertStagedRecords,
  migrateDb,
  registerSourceDocument,
  seedDatabase,
  startExtractionRun,
} from "@pebble/db";
import type { NewStagedRecord } from "@pebble/db";
import type { StagedMaterialBundle, StagedPricePoint } from "@pebble/shared";
import { autoApproveBatch } from "../src/auto-approve";
import type { AutoApproveReport } from "../src/auto-approve";

// ─── CLI parsing ────────────────────────────────────────────────────────────

interface CliArgs {
  mode: "remote" | "local";
  dryRun: boolean;
  limit: number;
  maxBatches: number;
  concurrency: number;
  workerUrl: string | null;
  demo: number;
}

function usage(): never {
  console.error(
    "Usage: auto-approve-drive.ts [--local] [--dry-run] [--limit <n>] " +
      "[--max-batches <n>] [--concurrency <n>] [--worker-url <u>] [--demo <n>]",
  );
  process.exit(2);
}

function parsePositive(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) usage();
  return n;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mode: "remote",
    dryRun: false,
    limit: 200,
    maxBatches: 30,
    concurrency: 4,
    workerUrl: null,
    demo: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--local":
        args.mode = "local";
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--limit":
        args.limit = parsePositive(argv[++i]);
        break;
      case "--max-batches":
        args.maxBatches = parsePositive(argv[++i]);
        break;
      case "--concurrency":
        args.concurrency = parsePositive(argv[++i]);
        break;
      case "--worker-url":
        args.workerUrl = argv[++i] ?? usage();
        break;
      case "--demo":
        args.demo = parsePositive(argv[++i]);
        break;
      default:
        usage();
    }
  }
  return args;
}

// ─── Table printing (mirrors backfill-ingest) ───────────────────────────────

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)));
  const line = (cells: string[]): string => cells.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join("  ");
  console.log(line(headers));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(r));
}

const BATCH_HEADERS = ["batch", "processed", "approved", "rejected", "unsure", "skipped", "degraded", "cost", "remaining"];

function batchRow(n: number, r: AutoApproveReport): string[] {
  return [
    String(n),
    String(r.processed),
    String(r.approved),
    String(r.rejected),
    String(r.unsure),
    String(r.skippedInvalid),
    String(r.degraded),
    `$${r.costUsd.toFixed(4)}`,
    String(r.remainingProposed),
  ];
}

interface Aggregate {
  batches: number;
  processed: number;
  approved: number;
  rejected: number;
  unsure: number;
  skippedInvalid: number;
  degraded: number;
  costUsd: number;
}

function emptyAggregate(): Aggregate {
  return { batches: 0, processed: 0, approved: 0, rejected: 0, unsure: 0, skippedInvalid: 0, degraded: 0, costUsd: 0 };
}

function accumulate(agg: Aggregate, r: AutoApproveReport): void {
  agg.batches += 1;
  agg.processed += r.processed;
  agg.approved += r.approved;
  agg.rejected += r.rejected;
  agg.unsure += r.unsure;
  agg.skippedInvalid += r.skippedInvalid;
  agg.degraded += r.degraded;
  agg.costUsd += r.costUsd;
}

function printSummary(agg: Aggregate, last: AutoApproveReport | null, dryRun: boolean): void {
  console.log(
    `\n${agg.batches} batch(es)${dryRun ? " (DRY RUN — nothing written)" : ""}: ` +
      `processed=${agg.processed} approved=${agg.approved} rejected=${agg.rejected} ` +
      `unsure=${agg.unsure} skippedInvalid=${agg.skippedInvalid} degraded=${agg.degraded} ` +
      `cost=$${agg.costUsd.toFixed(4)} remaining=${last?.remainingProposed ?? "?"}`,
  );
  if (last && (last.examples.rejected.length > 0 || last.examples.unsure.length > 0)) {
    console.log("\nExamples (from the last batch):");
    for (const e of last.examples.rejected) console.log(`  REJECT ${e.id}: ${e.issue}`);
    for (const e of last.examples.unsure) console.log(`  UNSURE ${e.id}: ${e.issue}`);
  }
}

// ─── --remote ────────────────────────────────────────────────────────────────

async function runRemote(args: CliArgs): Promise<void> {
  const workerUrl = (args.workerUrl ?? process.env.WORKER_URL)?.replace(/\/$/, "");
  if (!workerUrl) throw new Error("--remote requires WORKER_URL (or --worker-url)");

  // OIDC identity token for the worker (Cloud Run IAM) — same two lanes as
  // backfill-ingest: gcloud user token (re-minted every 45 min) or ADC.
  let authHeader: () => Promise<string>;
  if (process.env.WORKER_TOKEN_FROM_GCLOUD === "1") {
    const { execFileSync } = await import("node:child_process");
    let cached: { token: string; mintedAt: number } | null = null;
    authHeader = async () => {
      if (!cached || Date.now() - cached.mintedAt > 45 * 60 * 1000) {
        const token = execFileSync("gcloud", ["auth", "print-identity-token"], { encoding: "utf8" }).trim();
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

  const request = async (body: string): Promise<AutoApproveReport> => {
    const res = await fetch(`${workerUrl}/tasks/auto-approve`, {
      method: "POST",
      headers: { authorization: await authHeader(), "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(900_000),
    });
    const data = (await res.json().catch(() => null)) as (AutoApproveReport & { error?: string }) | null;
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${data?.error ?? ""}`);
      (err as unknown as { status: number }).status = res.status;
      throw err;
    }
    return data as AutoApproveReport;
  };

  const postBatch = async (): Promise<AutoApproveReport> => {
    const body = JSON.stringify({ limit: args.limit, dryRun: args.dryRun, concurrency: args.concurrency });
    try {
      return await request(body);
    } catch (err) {
      if ((err as { status?: number }).status !== undefined && (err as { status: number }).status >= 500) {
        return request(body); // one retry on a 5xx
      }
      throw err;
    }
  };

  await driveLoop(args, postBatch);
}

// ─── --local ───────────────────────────────────────────────────────────────

/** Deterministic OFFLINE verifier for `--demo`: rotates approve/reject/unsure. */
function demoStubModel(): LanguageModel {
  let n = 0;
  const model = {
    specificationVersion: "v2",
    provider: "demo-stub",
    modelId: "gemini-demo-stub",
    supportedUrls: {},
    doGenerate: async () => {
      const verdict = (["approve", "reject", "unsure"] as const)[n++ % 3];
      const payload = {
        verdict,
        confidence: verdict === "approve" ? 0.95 : 0.4,
        issues: verdict === "approve" ? [] : [`demo ${verdict} reason`],
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        finishReason: "stop",
        usage: { inputTokens: 800, outputTokens: 120, totalTokens: 920 },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("doStream not implemented in demo stub");
    },
  } as unknown as LanguageModel;
  return model;
}

/** Seed masters + `n` synthetic PROPOSED rows so `--local --demo` has something to chew on. */
async function seedDemo(db: Parameters<typeof autoApproveBatch>[0]["db"], n: number): Promise<void> {
  await seedDatabase(db);
  const { id: docId } = await registerSourceDocument(db, {
    filename: "DEMO Auto-Approve (01012025 R0).pdf",
    storageUri: `file:///demo/auto-approve-${Date.now()}.pdf`,
    docType: "proposal",
  });
  const runId = await startExtractionRun(db, {
    sourceDocumentId: docId,
    model: "demo-seed",
    promptVersion: "demo-v1",
  });
  const records: NewStagedRecord[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      const bundle: StagedMaterialBundle = {
        payloadVersion: 1,
        material: {
          materialCode: `DEMO-ACC-${String(i).padStart(3, "0")}`,
          materialName: `Demo Accessory ${i}`,
          systemType: "Common",
          category: "Accessory",
          unitOfMeasure: { raw: "No.", normalized: "No." },
        },
        make: { brandName: { raw: "DemoBrand", normalized: null } },
        price: { sellRupees: 500 + i, rateKind: "SITC", validFromISO: "2025-01-01T00:00:00.000Z" },
        sourceText: `Demo Accessory ${i}; Make - DemoBrand; Rs ${500 + i}`,
      };
      records.push({ targetMaster: "materials", proposed: bundle, confidence: 0.9 });
    } else {
      const price: StagedPricePoint = {
        payloadVersion: 1,
        materialCode: "FAS-SMK-001",
        brandName: { raw: "Agni", normalized: "Agni Devices" },
        sellRupees: 1400 + i,
        rateKind: "SITC",
        validFromISO: "2025-01-01T00:00:00.000Z",
        sourceText: `Photoelectric Smoke Detector; Make - Agni; Rs ${1400 + i}`,
      };
      records.push({ targetMaster: "prices", proposed: price, confidence: 0.9 });
    }
  }
  await insertStagedRecords(db, runId, records);
}

async function runLocal(args: CliArgs): Promise<void> {
  const handle = await createDb();
  if (handle.kind === "pglite") await migrateDb(handle);
  try {
    if (args.demo > 0) await seedDemo(handle.db, args.demo);

    const model = args.demo > 0
      ? demoStubModel()
      : createGeminiModelFromEnv(process.env, process.env.PEBBLE_VERIFY_MODEL ?? modelConfigFromEnv(process.env).gemini);
    if (model === null) {
      throw new Error(
        "no Gemini lane configured — set GOOGLE_GENERATIVE_AI_API_KEY / Vertex env, or use --demo for an offline smoke",
      );
    }
    const deps = { db: handle.db, ai: { model, embedder: createEmbedder(process.env) } };
    await driveLoop(args, () =>
      autoApproveBatch(deps, { limit: args.limit, dryRun: args.dryRun, concurrency: args.concurrency }),
    );
  } finally {
    await handle.close();
  }
}

// ─── Batch loop (shared by both modes) ───────────────────────────────────────

async function driveLoop(args: CliArgs, runBatch: () => Promise<AutoApproveReport>): Promise<void> {
  const agg = emptyAggregate();
  const rows: string[][] = [];
  let last: AutoApproveReport | null = null;

  for (let batch = 1; batch <= args.maxBatches; batch++) {
    const report = await runBatch();
    accumulate(agg, report);
    rows.push(batchRow(batch, report));
    last = report;

    if (args.dryRun) break; // a dry run never changes remainingProposed
    if (report.remainingProposed === 0) break; // queue drained
    if (report.approved + report.rejected === 0) {
      // No forward progress (all unsure / skipped / invalid stay PROPOSED) —
      // further identical batches would re-pull the same rows. Stop.
      console.log(`\nBatch ${batch} resolved nothing (all remaining rows are unsure/invalid) — stopping.`);
      break;
    }
  }

  printTable(BATCH_HEADERS, rows);
  printSummary(agg, last, args.dryRun);

  if (!args.dryRun && last && last.remainingProposed > 0) {
    console.log(`\n${last.remainingProposed} row(s) remain PROPOSED for human review.`);
  }
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "remote") await runRemote(args);
  else await runLocal(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
