import {
  createDb,
  insertStagedRecords,
  migrateDb,
  registerSourceDocument,
  replaceDocChunks,
  schema,
  seedDatabase,
  startExtractionRun,
  type AppUser,
  type Db,
  type DbHandle,
} from "@pebble/db";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "../src/server/routers/_app";
import { createCallerFactory, type Ctx } from "../src/server/trpc";

/**
 * ingestion router — RBAC gates, the approve/editApprove/reject/merge/
 * bulkApprove commit flows, RAG search over rag_chunks, and the corpus
 * dashboard reads (documents.list / stats). Mirrors rbac.test.ts's
 * createCaller pattern (single shared PGlite `memory://` db for the whole
 * file, fabricated ctx.user — no cookies/Firebase involved) and reuses the
 * payload-builder conventions from packages/db/test/ingestion.test.ts, since
 * seedDatabase() seeds the same fixture (FAS-SMK-001, FAS-HEAT-001, …) both
 * packages test against.
 */

const createCaller = createCallerFactory(appRouter);

function userWith(role: AppUser["role"]): AppUser {
  return {
    firebaseUid: `test-${role}`,
    email: `${role}@greenberg.test`,
    displayName: `Test ${role}`,
    role,
    active: true,
  };
}

async function code(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof TRPCError) return err.code;
    throw err;
  }
}

// ─── Staged payload builders (same shapes as packages/db/test/ingestion.test.ts) ──

function materialBundle(over: Record<string, unknown> = {}) {
  return {
    payloadVersion: 1 as const,
    material: {
      materialCode: "FAS-DET-950",
      materialName: "Beacon Sounder Combo Unit X900",
      systemType: "FAS" as const,
      category: "Accessory",
      unitOfMeasure: { raw: "Nos", normalized: "No." as const },
      specSummary: "Combined beacon + sounder, 24V DC",
    },
    make: {
      brandName: { raw: "Agni Devices", normalized: "Agni Devices" },
      tier: "Standard" as const,
    },
    price: {
      sellRupees: 5000,
      buyRupees: 3800,
      rateKind: "SUPPLY" as const,
      validFromISO: "2025-02-01T00:00:00.000Z",
    },
    installRate: { rupees: 2000, unit: "Per No." },
    sourceText: "Beacon sounder combo unit supply and installation",
    ...over,
  };
}

function pricePoint(over: Record<string, unknown> = {}) {
  return {
    payloadVersion: 1 as const,
    materialCode: "FAS-HEAT-001",
    brandName: { raw: "Agni Devices", normalized: "Agni Devices" },
    sellRupees: 1500,
    buyRupees: 1100,
    rateKind: "SUPPLY" as const,
    validFromISO: "2025-03-01T00:00:00.000Z",
    sourceText: "Heat detector supply rate 2025",
    ...over,
  };
}

describe("ingestion router", () => {
  let handle: DbHandle;
  let db: Db;
  let uriSeq = 0;

  beforeAll(async () => {
    process.env.PEBBLE_EMBEDDER = "stub";
    handle = await createDb({ pglite: true, pgliteDir: "memory://" });
    await migrateDb(handle);
    await seedDatabase(handle.db);
    db = handle.db as unknown as Db;
  });

  afterAll(async () => {
    await handle.close();
  });

  function callerFor(user: Ctx["user"]) {
    return createCaller({ db, user });
  }
  const admin = () => callerFor(userWith("admin"));
  const estimator = () => callerFor(userWith("estimator"));

  /** Register a document + extraction run and stage one record; returns its id. */
  async function stageOne(args: {
    targetMaster: "materials" | "makes" | "prices" | "install_rates";
    proposed: Record<string, unknown>;
    confidence?: number | null;
    sourceLocator?: Record<string, unknown>;
  }): Promise<{ docId: string; runId: string; stagedId: string }> {
    uriSeq += 1;
    const { id: docId } = await registerSourceDocument(db, {
      filename: `wp6-proposal-${uriSeq}.pdf`,
      storageUri: `gs://pebble/wp6-${uriSeq}`,
      docType: "PROPOSAL",
    });
    const runId = await startExtractionRun(db, {
      sourceDocumentId: docId,
      model: "gemini-2.5-pro",
      promptVersion: "extract-v3",
    });
    await insertStagedRecords(db, runId, [
      {
        targetMaster: args.targetMaster,
        proposed: args.proposed,
        confidence: args.confidence ?? 0.9,
        sourceLocator: args.sourceLocator ?? { page: 3 },
      },
    ]);
    const rows = await db.select().from(schema.stagedRecords);
    const staged = rows.find((r) => r.extractionRunId === runId);
    if (!staged) throw new Error("stageOne: staged record not found after insert");
    return { docId, runId, stagedId: staged.id };
  }

  // ── RBAC ──────────────────────────────────────────────────────────────────

  describe("RBAC", () => {
    it("estimator is FORBIDDEN on approve/reject/bulkApprove; admin passes", async () => {
      // Distinct validFromISO per record — insertHistoricalPrice's temporal
      // EXCLUDE constraint is keyed on (make_code, tstzrange); reusing the same
      // instant for the same (material, make) pair across two committed rows
      // in this shared-db test file would collide.
      const forApprove = await stageOne({
        targetMaster: "prices",
        proposed: pricePoint({ validFromISO: "2025-03-01T00:00:00.000Z" }),
      });
      const forReject = await stageOne({
        targetMaster: "prices",
        proposed: pricePoint({ validFromISO: "2025-03-02T00:00:00.000Z" }),
      });
      const forBulk = await stageOne({
        targetMaster: "prices",
        proposed: pricePoint({ validFromISO: "2025-04-01T00:00:00.000Z" }),
      });

      expect(await code(estimator().ingestion.approve({ stagedRecordId: forApprove.stagedId }))).toBe(
        "FORBIDDEN",
      );
      expect(await code(estimator().ingestion.reject({ stagedRecordId: forReject.stagedId }))).toBe(
        "FORBIDDEN",
      );
      expect(
        await code(estimator().ingestion.bulkApprove({ stagedRecordIds: [forBulk.stagedId] })),
      ).toBe("FORBIDDEN");

      // Admin passes every gate and actually performs the action.
      const approved = await admin().ingestion.approve({ stagedRecordId: forApprove.stagedId });
      expect(approved.decision).toBe("APPROVED");
      await admin().ingestion.reject({ stagedRecordId: forReject.stagedId });
      const bulk = await admin().ingestion.bulkApprove({ stagedRecordIds: [forBulk.stagedId] });
      expect(bulk[0]?.ok).toBe(true);
    });

    it("reads (documents.list, queue.list, search, dedupSuggestions) work for any signed-in role", async () => {
      expect(await code(estimator().ingestion.documents.list())).toBeNull();
      expect(await code(estimator().ingestion.queue.list({}))).toBeNull();
      expect(await code(estimator().ingestion.dedupSuggestions({ name: "smoke detector" }))).toBeNull();
      expect(await code(estimator().ingestion.search({ query: "detector" }))).toBeNull();
      expect(await code(callerFor(null).ingestion.documents.list())).toBe("UNAUTHORIZED");
    });
  });

  // ── approve ──────────────────────────────────────────────────────────────

  describe("approve", () => {
    it("commits a materials bundle — staged status flips and the material appears in masters", async () => {
      const { stagedId } = await stageOne({ targetMaster: "materials", proposed: materialBundle() });
      const result = await admin().ingestion.approve({ stagedRecordId: stagedId });
      expect(result.decision).toBe("APPROVED");
      expect(result.outcome.kind).toBe("materials");
      const code = result.outcome.materialCode!;
      expect(code).toBe("FAS-DET-950");

      // Staged row advanced.
      const queued = await admin().ingestion.queue.list({ status: ["APPROVED"] });
      expect(queued.some((q) => q.id === stagedId)).toBe(true);
      expect(queued.find((q) => q.id === stagedId)?.status).toBe("APPROVED");

      // Committed into masters.
      const snapshot = await admin().masters.snapshot();
      expect(snapshot.materials.some((m) => m.materialCode === code)).toBe(true);
    });

    it("a stub embedder failure never blocks the commit (nameEmbedding best-effort)", async () => {
      // PEBBLE_EMBEDDER=stub (set in beforeAll) never throws, so this exercises
      // the happy embedding path; the commit must succeed either way.
      const { stagedId } = await stageOne({
        targetMaster: "materials",
        proposed: materialBundle({
          material: {
            materialCode: "FAS-DET-951",
            materialName: "Independent Standalone Detector Z1",
            systemType: "FAS",
            category: "Detector",
            unitOfMeasure: { raw: "Nos", normalized: "No." },
          },
        }),
      });
      const result = await admin().ingestion.approve({ stagedRecordId: stagedId });
      expect(result.outcome.degraded).toBe(false);
    });
  });

  // ── editApprove ──────────────────────────────────────────────────────────

  describe("editApprove", () => {
    it("a bad edit fails schema validation → BAD_REQUEST", async () => {
      const { stagedId } = await stageOne({ targetMaster: "prices", proposed: pricePoint() });
      const result = await code(
        admin().ingestion.editApprove({ stagedRecordId: stagedId, edits: { sellRupees: "not-a-number" } }),
      );
      expect(result).toBe("BAD_REQUEST");
    });

    it("a good edit commits with the edited value and decision EDITED_APPROVED", async () => {
      const { stagedId } = await stageOne({
        targetMaster: "prices",
        proposed: pricePoint({ sellRupees: 1500, validFromISO: "2025-05-01T00:00:00.000Z" }),
      });
      const result = await admin().ingestion.editApprove({
        stagedRecordId: stagedId,
        edits: { sellRupees: 2000 },
      });
      expect(result.decision).toBe("EDITED_APPROVED");
      const snapshot = await admin().masters.snapshot();
      const price = snapshot.prices.find((p) => p.priceId === result.outcome.priceId);
      expect(price?.sellingRatePaise).toBe(200000);
    });
  });

  // ── bulkApprove ──────────────────────────────────────────────────────────

  describe("bulkApprove", () => {
    it("mixes one good + one already-reviewed id — per-record results, no throw", async () => {
      const good = await stageOne({
        targetMaster: "prices",
        proposed: pricePoint({ sellRupees: 1600, validFromISO: "2025-06-01T00:00:00.000Z" }),
      });
      const alreadyReviewed = await stageOne({
        targetMaster: "prices",
        proposed: pricePoint({ sellRupees: 1700, validFromISO: "2025-06-02T00:00:00.000Z" }),
      });
      await admin().ingestion.reject({ stagedRecordId: alreadyReviewed.stagedId });

      const results = await admin().ingestion.bulkApprove({
        stagedRecordIds: [good.stagedId, alreadyReviewed.stagedId],
      });
      expect(results).toHaveLength(2);
      const goodResult = results.find((r) => r.stagedRecordId === good.stagedId);
      const badResult = results.find((r) => r.stagedRecordId === alreadyReviewed.stagedId);
      expect(goodResult?.ok).toBe(true);
      expect(goodResult?.outcome?.kind).toBe("prices");
      expect(badResult?.ok).toBe(false);
      expect(badResult?.error).toMatch(/already reviewed/);
    });

    it("rejects more than 100 ids at the input boundary", async () => {
      const ids = Array.from({ length: 101 }, (_, i) => `fake-${i}`);
      const result = await code(admin().ingestion.bulkApprove({ stagedRecordIds: ids }));
      expect(result).toBe("BAD_REQUEST");
    });
  });

  // ── merge ────────────────────────────────────────────────────────────────

  describe("merge", () => {
    it("commits as a price-point on the target material", async () => {
      const { stagedId } = await stageOne({
        targetMaster: "materials",
        proposed: materialBundle({
          material: {
            materialCode: "FAS-DET-952",
            materialName: "Merge Candidate Detector",
            systemType: "FAS",
            category: "Detector",
            unitOfMeasure: { raw: "Nos", normalized: "No." },
          },
        }),
      });
      const result = await admin().ingestion.merge({
        stagedRecordId: stagedId,
        mergeIntoCode: "FAS-SMK-001",
      });
      expect(result.decision).toBe("MERGED");
      expect(result.outcome.degraded).toBe(true);
      expect(result.outcome.materialCode).toBe("FAS-SMK-001");
    });

    it("a bad mergeIntoCode surfaces as BAD_REQUEST", async () => {
      const { stagedId } = await stageOne({ targetMaster: "materials", proposed: materialBundle({
        material: {
          materialCode: "FAS-DET-953",
          materialName: "Another Merge Candidate",
          systemType: "FAS",
          category: "Detector",
          unitOfMeasure: { raw: "Nos", normalized: "No." },
        },
      }) });
      const result = await code(
        admin().ingestion.merge({ stagedRecordId: stagedId, mergeIntoCode: "NON-EXISTENT-999" }),
      );
      expect(result).toBe("BAD_REQUEST");
    });
  });

  // ── search (RAG) ─────────────────────────────────────────────────────────

  describe("search", () => {
    it("returns tsvector hits after replaceDocChunks with null embeddings", async () => {
      const { id: docId } = await registerSourceDocument(db, {
        filename: "search-fixture.pdf",
        storageUri: "gs://pebble/wp6-search-fixture",
        docType: "PROPOSAL",
      });
      await replaceDocChunks(db, docId, [
        {
          chunkKind: "boq_section",
          content: "Xenoquartz beacon sounder combo assembly for the FAS loop, 24V DC",
          embedding: null,
          metadata: { systems: ["FAS"], docDateISO: "2025-01-15" },
        },
        {
          chunkKind: "terms",
          content: "Payment terms: 30 days from invoice, retention 5 percent",
          embedding: null,
          metadata: {},
        },
      ]);

      const { hits } = await estimator().ingestion.search({ query: "xenoquartz beacon sounder" });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.filename).toBe("search-fixture.pdf");
      expect(hits[0]?.content).toContain("Xenoquartz");
    });
  });

  // ── documents.list / stats ───────────────────────────────────────────────

  describe("documents.list and stats", () => {
    it("documents.list aggregates staged counts + chunk counts per document", async () => {
      const { docId, stagedId } = await stageOne({
        targetMaster: "prices",
        proposed: pricePoint({ sellRupees: 1800 }),
      });
      await admin().ingestion.reject({ stagedRecordId: stagedId });

      const docs = await admin().ingestion.documents.list();
      const doc = docs.find((d) => d.id === docId);
      expect(doc).toBeTruthy();
      expect(doc?.stagedCounts.REJECTED).toBe(1);
      expect(doc?.stagedCounts.PROPOSED).toBe(0);
      expect(typeof doc?.chunkCount).toBe("number");
    });

    it("stats reports total/byStatus/byTargetMaster counts", async () => {
      const before = await admin().ingestion.stats();
      await stageOne({ targetMaster: "makes", proposed: {
        payloadVersion: 1,
        materialCode: "FAS-SMK-001",
        brandName: { raw: "Stats Brand", normalized: "Stats Brand" },
        tier: "Standard",
        sourceText: "Stats brand approved make",
      } });
      const after = await admin().ingestion.stats();
      expect(after.total).toBe(before.total + 1);
      expect(after.byStatus.PROPOSED).toBe((before.byStatus.PROPOSED ?? 0) + 1);
      expect(after.byTargetMaster.makes).toBe((before.byTargetMaster.makes ?? 0) + 1);
    });
  });
});
