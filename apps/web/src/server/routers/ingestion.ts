import { createEmbedder } from "@pebble/ai";
import {
  commitStagedRecord,
  hybridSearch,
  listQueue,
  listSourceDocuments,
  rejectStagedRecord,
  schema,
  trgmMaterialCandidates,
  type CommitOutcome,
  type Db,
  type QueueItem,
} from "@pebble/db";
import { STAGED_RECORD_STATUSES, TARGET_MASTERS } from "@pebble/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, roleProcedure, router } from "../trpc";

/**
 * Ingestion + RAG router (Phase B, WP6). Reads (documents/queue/search/dedup)
 * are protectedProcedure — any signed-in role can see the corpus and search
 * it; every mutation that writes to the staged-record queue or commits into
 * masters is roleProcedure("admin") — verification is an admin-only act.
 *
 * A dedicated `reingest` procedure that talks to the worker client is added by
 * a later WP; this router only reads/reviews what the worker has already
 * staged.
 */

// ─── Error translation ──────────────────────────────────────────────────────

/**
 * Translate a repo-thrown error into a typed TRPC error. zod validation
 * failures (from `stagedPayloadSchemaFor(...).parse(merged)` inside
 * commitStagedRecord) are reformatted into a readable "path: message" list
 * rather than surfacing the raw ZodError JSON; "not found" messages become
 * NOT_FOUND; everything else (already-reviewed, bad mergeIntoCode, invalid
 * category, …) is a BAD_REQUEST carrying the repo's own message.
 */
function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof z.ZodError) {
    const message = err.issues
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    return new TRPCError({ code: "BAD_REQUEST", message });
  }
  const message = err instanceof Error ? err.message : String(err);
  const code = /not found/i.test(message) ? "NOT_FOUND" : "BAD_REQUEST";
  return new TRPCError({ code, message });
}

// ─── queue.item (single staged row + document, joined) ─────────────────────

/**
 * Single staged-record lookup joined to its document, mirroring listQueue's
 * shape exactly. The ingestion repo only exposes a list (`listQueue`) with no
 * id filter; rather than pull in drizzle operators here, this joins in JS from
 * three small full-table selects — the same "free of drizzle operator
 * imports" house style the web layer's other cross-cutting reads use (see
 * src/server/queries.ts).
 */
async function getQueueItem(db: Db, stagedRecordId: string): Promise<QueueItem | null> {
  const [stagedRows, runRows, docRows] = await Promise.all([
    db.select().from(schema.stagedRecords),
    db.select().from(schema.extractionRuns),
    db.select().from(schema.sourceDocuments),
  ]);
  const staged = stagedRows.find((r) => r.id === stagedRecordId);
  if (!staged) return null;
  const run = runRows.find((r) => r.id === staged.extractionRunId);
  const doc = run ? docRows.find((d) => d.id === run.sourceDocumentId) : undefined;
  if (!run || !doc) return null;

  return {
    id: staged.id,
    extractionRunId: staged.extractionRunId,
    targetMaster: staged.targetMaster as QueueItem["targetMaster"],
    proposed: staged.proposed,
    confidence: staged.confidence === null ? null : Number(staged.confidence),
    dedupCandidateCode: staged.dedupCandidateCode ?? null,
    sourceLocator: staged.sourceLocator ?? null,
    status: staged.status,
    reviewedBy: staged.reviewedBy ?? null,
    reviewedAt: staged.reviewedAt ?? null,
    createdAt: staged.createdAt,
    filename: doc.filename,
    fileRef: doc.fileRef ?? null,
    sourceDocumentId: doc.id,
  };
}

// ─── best-effort material-name embedding ────────────────────────────────────

/**
 * Best-effort embedding of the (possibly edited) material name for a staged
 * "materials" bundle, for the dedup-friendly material_name_embeddings upsert
 * that commitStagedRecord performs when given `nameEmbedding`. Non-materials
 * targets and any embedder failure resolve to null — embedding is a nice-to-
 * have, never a reason to block a commit.
 */
async function tryBuildNameEmbedding(
  db: Db,
  stagedRecordId: string,
  edits?: Record<string, unknown>,
): Promise<{ embedding: number[]; model: string } | null> {
  try {
    const rows = await db.select().from(schema.stagedRecords);
    const row = rows.find((r) => r.id === stagedRecordId);
    if (!row || row.targetMaster !== "materials") return null;

    const merged = { ...row.proposed, ...(edits ?? {}) } as { material?: { materialName?: unknown } };
    const name = merged.material?.materialName;
    if (typeof name !== "string" || name.trim() === "") return null;

    const embedder = createEmbedder(process.env);
    const [embedding] = await embedder.embed([name]);
    if (!embedding) return null;
    return { embedding, model: embedder.model };
  } catch {
    return null;
  }
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

const queueListInput = z.object({
  status: z.array(z.enum(STAGED_RECORD_STATUSES)).optional(),
  targetMaster: z.enum(TARGET_MASTERS).optional(),
  sourceDocumentId: z.string().min(1).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});

const stagedRecordIdInput = z.object({ stagedRecordId: z.string().min(1) });

export const ingestionRouter = router({
  documents: router({
    /** Every registered source document with staged-record + chunk tallies. */
    list: protectedProcedure.query(async ({ ctx }) => {
      return listSourceDocuments(ctx.db);
    }),
  }),

  queue: router({
    /** The verification queue, filterable by status/target/document/confidence. */
    list: protectedProcedure.input(queueListInput).query(async ({ ctx, input }) => {
      return listQueue(ctx.db, {
        status: input.status,
        targetMaster: input.targetMaster,
        sourceDocumentId: input.sourceDocumentId,
        minConfidence: input.minConfidence,
        limit: input.limit ?? 50,
        offset: input.offset,
      });
    }),

    /** One staged row joined to its source document, for the queue detail pane. */
    item: protectedProcedure.input(stagedRecordIdInput).query(async ({ ctx, input }) => {
      const item = await getQueueItem(ctx.db, input.stagedRecordId);
      if (!item) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Staged record ${input.stagedRecordId} not found` });
      }
      return item;
    }),
  }),

  /** Approve a staged row as-is → commits into the masters with provenance. */
  approve: roleProcedure("admin")
    .input(stagedRecordIdInput)
    .mutation(async ({ ctx, input }) => {
      const nameEmbedding = await tryBuildNameEmbedding(ctx.db, input.stagedRecordId);
      try {
        return await commitStagedRecord(ctx.db, {
          stagedRecordId: input.stagedRecordId,
          reviewer: ctx.user.firebaseUid,
          decision: "APPROVED",
          nameEmbedding: nameEmbedding?.embedding ?? null,
          embeddingModel: nameEmbedding?.model ?? null,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Approve with reviewer edits merged over the proposed payload before validation. */
  editApprove: roleProcedure("admin")
    .input(stagedRecordIdInput.extend({ edits: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      const nameEmbedding = await tryBuildNameEmbedding(ctx.db, input.stagedRecordId, input.edits);
      try {
        return await commitStagedRecord(ctx.db, {
          stagedRecordId: input.stagedRecordId,
          reviewer: ctx.user.firebaseUid,
          decision: "EDITED_APPROVED",
          edits: input.edits,
          nameEmbedding: nameEmbedding?.embedding ?? null,
          embeddingModel: nameEmbedding?.model ?? null,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Reject a still-PROPOSED staged row. */
  reject: roleProcedure("admin")
    .input(stagedRecordIdInput)
    .mutation(async ({ ctx, input }) => {
      try {
        await rejectStagedRecord(ctx.db, {
          stagedRecordId: input.stagedRecordId,
          reviewer: ctx.user.firebaseUid,
        });
        return { ok: true };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Commit a duplicate material proposal as a price-point onto an existing material. */
  merge: roleProcedure("admin")
    .input(stagedRecordIdInput.extend({ mergeIntoCode: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const nameEmbedding = await tryBuildNameEmbedding(ctx.db, input.stagedRecordId);
      try {
        return await commitStagedRecord(ctx.db, {
          stagedRecordId: input.stagedRecordId,
          reviewer: ctx.user.firebaseUid,
          decision: "MERGED",
          mergeIntoCode: input.mergeIntoCode,
          nameEmbedding: nameEmbedding?.embedding ?? null,
          embeddingModel: nameEmbedding?.model ?? null,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Approve many staged rows in one round-trip, each in its OWN try/catch (not
   * one transaction) so a single bad record cannot poison an otherwise-clean
   * batch. The Shift+A "approve everything confident" queue shortcut is the
   * caller.
   */
  bulkApprove: roleProcedure("admin")
    .input(z.object({ stagedRecordIds: z.array(z.string().min(1)).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const results: Array<{
        stagedRecordId: string;
        ok: boolean;
        error?: string;
        outcome?: CommitOutcome;
      }> = [];
      for (const stagedRecordId of input.stagedRecordIds) {
        try {
          const nameEmbedding = await tryBuildNameEmbedding(ctx.db, stagedRecordId);
          const result = await commitStagedRecord(ctx.db, {
            stagedRecordId,
            reviewer: ctx.user.firebaseUid,
            decision: "APPROVED",
            nameEmbedding: nameEmbedding?.embedding ?? null,
            embeddingModel: nameEmbedding?.model ?? null,
          });
          results.push({ stagedRecordId, ok: true, outcome: result.outcome });
        } catch (err) {
          results.push({
            stagedRecordId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return results;
    }),

  /** Staged-record counts by status and by target master (corpus dashboard tiles). */
  stats: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        status: schema.stagedRecords.status,
        targetMaster: schema.stagedRecords.targetMaster,
      })
      .from(schema.stagedRecords);
    const byStatus: Record<string, number> = {};
    const byTargetMaster: Record<string, number> = {};
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      byTargetMaster[r.targetMaster] = (byTargetMaster[r.targetMaster] ?? 0) + 1;
    }
    return { total: rows.length, byStatus, byTargetMaster };
  }),

  /**
   * "What did we quote before?" hybrid search over rag_chunks. The query text
   * always drives the keyword arm; the embedding arm is best-effort (a missing
   * API key or an embedder failure just falls back to tsvector-only, matching
   * hybridSearch's own null-embedding path).
   */
  search: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1),
        k: z.number().int().positive().max(50).optional(),
        chunkKind: z.array(z.string()).optional(),
        systems: z.array(z.string()).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      let queryEmbedding: number[] | null = null;
      try {
        const embedder = createEmbedder(process.env);
        const [embedding] = await embedder.embed([input.query]);
        queryEmbedding = embedding ?? null;
      } catch {
        queryEmbedding = null;
      }
      const hits = await hybridSearch(ctx.db, {
        queryText: input.query,
        queryEmbedding,
        k: input.k ?? 12,
        filters: { chunkKind: input.chunkKind, systems: input.systems },
      });
      return { hits };
    }),

  /** Trigram material-name dedup candidates for the queue's merge card. */
  dedupSuggestions: protectedProcedure
    .input(z.object({ name: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      return trgmMaterialCandidates(ctx.db, input.name, 5);
    }),
});
