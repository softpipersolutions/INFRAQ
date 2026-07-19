import { toLlmCallLog, verifyStagedRecord, type Embedder, type LanguageModel } from "@pebble/ai";
import type { Db, QueueItem } from "@pebble/db";
import {
  commitStagedRecord,
  insertLlmCall,
  listQueue,
  listSourceDocuments,
  rejectStagedRecord,
} from "@pebble/db";
import { stagedPayloadSchemaFor, type StagedMaterialBundle, type TargetMaster } from "@pebble/shared";
import pLimit from "p-limit";
import { WorkerError } from "./errors";

/**
 * The Gemini FULL AUTO-APPROVE pass over staged ingestion records (Phase B).
 *
 * Phase B staged thousands of PROPOSED rows; the founder chose to let Gemini
 * verify each one and DIRECTLY commit or reject it — no human click. The guard
 * rails live here, not in the model:
 *
 *  - verification is a genuine SECOND pass (`verifyStagedRecord`, a fresh
 *    temperature-0 audit prompt), not a rubber stamp;
 *  - "unsure" (and anything the deterministic pre-gate can't even parse) stays
 *    PROPOSED for a human — the machine never forces a decision it isn't sure of;
 *  - every machine decision is ledgered — the commit stamps `reviewedBy:
 *    "gemini-auto"` and writes the existing STAGED_COMMITTED audit event, and
 *    EVERY model call is recorded in `llm_calls` with intent `staged-verify`;
 *  - a `dryRun` mode runs the verification and reports the would-be split
 *    WITHOUT any write, so the split can be inspected before anything commits.
 *
 * The model is injected (null → 503, mirroring the ingestion pipeline). The
 * expensive verification calls run concurrently; the DB mutations are funnelled
 * through a serial gate (`pLimit(1)`) so a single PGlite connection is never
 * asked to interleave two transactions — production (a node-postgres pool) is
 * unaffected.
 */

export interface AutoApproveDeps {
  db: Db;
  ai: { model: LanguageModel | null; embedder: Embedder };
}

export interface AutoApproveArgs {
  /** How many PROPOSED rows to pull for this batch (default 200). */
  limit?: number;
  /** Verify + report the would-be split but write nothing (default false). */
  dryRun?: boolean;
  /** Parallel verification calls (default 4). DB writes are always serialized. */
  concurrency?: number;
}

/** A capped illustrative example: the staged row id + the first issue behind its verdict. */
export interface AutoApproveExample {
  id: string;
  issue: string;
}

export interface AutoApproveReport {
  processed: number;
  approved: number;
  rejected: number;
  unsure: number;
  skippedInvalid: number;
  degraded: number;
  remainingProposed: number;
  costUsd: number;
  wallMs: number;
  /** True when this was a dry run — nothing was written and everything stays PROPOSED. */
  dryRun: boolean;
  examples: {
    rejected: AutoApproveExample[];
    unsure: AutoApproveExample[];
  };
}

const DEFAULT_LIMIT = 200;
const DEFAULT_CONCURRENCY = 4;
const EXAMPLE_CAP = 5;

function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

/**
 * Best-effort source-document date for the audit prompt. `QueueItem` does not
 * carry the document's date, so we fall back to the staged payload's
 * `validFromISO` (which staging derives from the document date) — present on
 * material bundles and price points, absent on make links / install rates.
 */
function docDateFromPayload(targetMaster: TargetMaster, proposed: unknown): string | null {
  const p = proposed as Record<string, unknown>;
  let iso: unknown;
  if (targetMaster === "materials") {
    iso = (p.price as Record<string, unknown> | undefined)?.validFromISO;
  } else if (targetMaster === "prices") {
    iso = p.validFromISO;
  }
  return typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null;
}

/** Count PROPOSED rows still outstanding, via the repo surface (no drizzle in the worker). */
async function countRemainingProposed(db: Db): Promise<number> {
  const docs = await listSourceDocuments(db);
  return docs.reduce((sum, d) => sum + (d.stagedCounts.PROPOSED ?? 0), 0);
}

/**
 * Verify one batch of PROPOSED staged records and (unless dryRun) commit /
 * reject each according to Gemini's verdict, leaving `unsure` + unparseable rows
 * for humans. Never throws for a per-record failure — a commit that races or hits
 * an EXCLUDE overlap is counted `unsure` and the batch carries on.
 */
export async function autoApproveBatch(
  deps: AutoApproveDeps,
  args: AutoApproveArgs = {},
): Promise<AutoApproveReport> {
  const startedAt = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;
  const concurrency = args.concurrency ?? DEFAULT_CONCURRENCY;
  const dryRun = args.dryRun ?? false;

  // Fail upfront, before any processing, when no verification model is configured.
  if (deps.ai.model === null) {
    throw new WorkerError("verification model not configured", 503);
  }
  const model = deps.ai.model;
  const modelId = modelIdOf(model);
  const embedder = deps.ai.embedder;

  const items = await listQueue(deps.db, { status: ["PROPOSED"], limit });

  let approved = 0;
  let rejected = 0;
  let unsure = 0;
  let skippedInvalid = 0;
  let degraded = 0;
  let costUsd = 0;
  const rejectedExamples: AutoApproveExample[] = [];
  const unsureExamples: AutoApproveExample[] = [];

  const collect = (bucket: AutoApproveExample[], id: string, issue: string): void => {
    if (bucket.length < EXAMPLE_CAP) bucket.push({ id, issue });
  };
  const firstIssue = (issues: string[], fallback: string): string =>
    issues.find((i) => i.trim().length > 0) ?? fallback;

  const runLimit = pLimit(concurrency);
  const dbLimit = pLimit(1); // serialize every DB mutation (PGlite-safe)

  const handle = async (item: QueueItem): Promise<void> => {
    const targetMaster = item.targetMaster;

    // 1. Deterministic pre-gate: the payload must still validate against its
    //    shared schema. It always should (staging validated it), but a bad row
    //    is left PROPOSED for a human rather than fed to the model or committed.
    const parsed = stagedPayloadSchemaFor(targetMaster).safeParse(item.proposed);
    if (!parsed.success) {
      skippedInvalid++;
      collect(unsureExamples, item.id, `invalid payload: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
      return;
    }
    const payload = parsed.data as { sourceText: string };

    // 3. Second-pass verification (all payload kinds carry sourceText).
    const result = await verifyStagedRecord({
      model,
      targetMaster,
      proposed: item.proposed,
      sourceText: payload.sourceText,
      filename: item.filename,
      docDateISO: docDateFromPayload(targetMaster, item.proposed),
    });

    // 8. Ledger EVERY Gemini call. In a dry run we still tally the (already
    //    incurred) cost but skip the DB insert so a dry run writes nothing.
    const log = toLlmCallLog({
      lane: "gemini",
      model: modelId,
      intent: "staged-verify",
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      sessionId: null,
    });
    costUsd += log.costUsd;
    if (!dryRun) {
      await dbLimit(() => insertLlmCall(deps.db, log));
    }

    // 7. dryRun: count the would-be split, collect examples, write nothing.
    if (dryRun) {
      if (result.verdict === "approve") approved++;
      else if (result.verdict === "reject") {
        rejected++;
        collect(rejectedExamples, item.id, firstIssue(result.issues, "would reject"));
      } else {
        unsure++;
        collect(unsureExamples, item.id, firstIssue(result.issues, "model unsure"));
      }
      return;
    }

    // 4. approve → commit into the masters as gemini-auto.
    if (result.verdict === "approve") {
      let nameEmbedding: number[] | null = null;
      if (targetMaster === "materials") {
        try {
          const name = (parsed.data as StagedMaterialBundle).material.materialName;
          const [vec] = await embedder.embed([name]);
          nameEmbedding = vec ?? null;
        } catch {
          nameEmbedding = null;
        }
      }
      try {
        const commitResult = await dbLimit(() =>
          commitStagedRecord(deps.db, {
            stagedRecordId: item.id,
            reviewer: "gemini-auto",
            decision: "APPROVED",
            nameEmbedding,
            embeddingModel: embedder.model,
          }),
        );
        approved++;
        if (commitResult.outcome.degraded) degraded++;
      } catch (err) {
        // EXCLUDE overlap, a race, a missing master, etc. — don't fail the
        // batch; leave the row PROPOSED and route it to a human as unsure.
        unsure++;
        collect(unsureExamples, item.id, `commit failed: ${(err as Error).message}`);
      }
      return;
    }

    // 5. reject → mark REJECTED as gemini-auto.
    if (result.verdict === "reject") {
      try {
        await dbLimit(() => rejectStagedRecord(deps.db, { stagedRecordId: item.id, reviewer: "gemini-auto" }));
        rejected++;
        collect(rejectedExamples, item.id, firstIssue(result.issues, "rejected"));
      } catch (err) {
        // Already reviewed by a concurrent actor / race — leave it be.
        unsure++;
        collect(unsureExamples, item.id, `reject failed: ${(err as Error).message}`);
      }
      return;
    }

    // 6. unsure → leave PROPOSED for a human.
    unsure++;
    collect(unsureExamples, item.id, firstIssue(result.issues, "model unsure"));
  };

  await Promise.all(items.map((item) => runLimit(() => handle(item))));

  const remainingProposed = await countRemainingProposed(deps.db);

  return {
    processed: items.length,
    approved,
    rejected,
    unsure,
    skippedInvalid,
    degraded,
    remainingProposed,
    costUsd,
    wallMs: Date.now() - startedAt,
    dryRun,
    examples: { rejected: rejectedExamples, unsure: unsureExamples },
  };
}

/** Validate a raw request body into `AutoApproveArgs`. */
export function parseAutoApproveArgs(body: Record<string, unknown>): AutoApproveArgs {
  const args: AutoApproveArgs = {};
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1) {
      throw new WorkerError("limit must be a positive integer", 400);
    }
    args.limit = body.limit;
  }
  if (body.concurrency !== undefined) {
    if (typeof body.concurrency !== "number" || !Number.isInteger(body.concurrency) || body.concurrency < 1) {
      throw new WorkerError("concurrency must be a positive integer", 400);
    }
    args.concurrency = body.concurrency;
  }
  if (body.dryRun !== undefined) {
    if (typeof body.dryRun !== "boolean") throw new WorkerError("dryRun must be a boolean", 400);
    args.dryRun = body.dryRun;
  }
  return args;
}
