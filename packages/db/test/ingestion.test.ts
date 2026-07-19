import { sourceProvenanceSchema } from "@pebble/shared";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/index";
import {
  commitStagedRecord,
  deleteProposedForDocument,
  finishExtractionRun,
  insertHistoricalPrice,
  insertStagedRecords,
  listQueue,
  listSourceDocuments,
  registerSourceDocument,
  rejectStagedRecord,
  startExtractionRun,
} from "../src/index";
import {
  auditEvents,
  extractionRuns,
  installRates,
  makes,
  materialSpecs,
  materials,
  prices,
  stagedRecords,
} from "../src/schema";
import { freshDb } from "./helpers";

let handle: DbHandle;
beforeEach(async () => {
  handle = await freshDb();
});
afterEach(async () => {
  await handle.close();
});

// ─── Payload builders ───────────────────────────────────────────────────────

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

let uriSeq = 0;
async function stageOne(args: {
  targetMaster: "materials" | "makes" | "prices" | "install_rates";
  proposed: Record<string, unknown>;
  sourceLocator?: Record<string, unknown>;
}) {
  uriSeq += 1;
  const uri = `gs://pebble/doc-${uriSeq}`;
  const { id: docId } = await registerSourceDocument(handle.db, {
    filename: `proposal-${uriSeq}.pdf`,
    storageUri: uri,
    docType: "PROPOSAL",
  });
  const runId = await startExtractionRun(handle.db, {
    sourceDocumentId: docId,
    model: "gemini-2.5-pro",
    promptVersion: "extract-v3",
  });
  await insertStagedRecords(handle.db, runId, [
    {
      targetMaster: args.targetMaster,
      proposed: args.proposed,
      confidence: 0.9,
      sourceLocator: args.sourceLocator ?? { page: 4 },
    },
  ]);
  const rows = await handle.db
    .select({ id: stagedRecords.id })
    .from(stagedRecords)
    .where(eq(stagedRecords.extractionRunId, runId));
  return { docId, runId, stagedId: rows[0]!.id };
}

async function timeline(materialCode: string, makeCode: string) {
  const rows = await handle.db
    .select({ validFrom: prices.validFrom, validTo: prices.validTo })
    .from(prices)
    .where(and(eq(prices.materialCode, materialCode), eq(prices.makeCode, makeCode)))
    .orderBy(asc(prices.validFrom));
  return rows.map((r) => ({
    from: r.validFrom.toISOString(),
    to: r.validTo ? r.validTo.toISOString() : null,
  }));
}

/** A fresh make on a seeded material with an empty price timeline. */
async function freshMake(tag: string): Promise<string> {
  const makeCode = `FAS-SMK-001-${tag}`;
  await handle.db.insert(makes).values({
    makeCode,
    materialCode: "FAS-SMK-001",
    brandName: `Brand ${tag}`,
    tier: "Standard",
    approvalStatus: "Conditional",
  });
  return makeCode;
}

const T1 = new Date("2020-01-01T00:00:00.000Z");
const T2 = new Date("2021-01-01T00:00:00.000Z");
const T3 = new Date("2022-01-01T00:00:00.000Z");
const T4 = new Date("2023-01-01T00:00:00.000Z");

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("registerSourceDocument", () => {
  it("is idempotent on storageUri (same uri → same id, existing true)", async () => {
    const first = await registerSourceDocument(handle.db, {
      filename: "a.pdf",
      storageUri: "gs://pebble/unique-1",
      docType: "PROPOSAL",
    });
    expect(first.existing).toBe(false);
    const second = await registerSourceDocument(handle.db, {
      filename: "a-again.pdf",
      storageUri: "gs://pebble/unique-1",
      docType: "PROPOSAL",
    });
    expect(second.existing).toBe(true);
    expect(second.id).toBe(first.id);
  });
});

describe("extraction run lifecycle + staged validation", () => {
  it("starts RUNNING and finishes with status + costUsd", async () => {
    const { id: docId } = await registerSourceDocument(handle.db, {
      filename: "b.pdf",
      storageUri: "gs://pebble/run-1",
      docType: "DSR",
    });
    const runId = await startExtractionRun(handle.db, {
      sourceDocumentId: docId,
      model: "m",
      promptVersion: "v1",
    });
    let [run] = await handle.db.select().from(extractionRuns).where(eq(extractionRuns.id, runId));
    expect(run?.status).toBe("RUNNING");
    expect(run?.finishedAt).toBeNull();

    await finishExtractionRun(handle.db, runId, { status: "SUCCEEDED", costUsd: 0.0123 });
    [run] = await handle.db.select().from(extractionRuns).where(eq(extractionRuns.id, runId));
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.finishedAt).not.toBeNull();
    expect(Number(run?.costUsd)).toBeCloseTo(0.0123, 6);
  });

  it("rejects a batch when a record's payload is invalid, naming the index", async () => {
    const { id: docId } = await registerSourceDocument(handle.db, {
      filename: "c.pdf",
      storageUri: "gs://pebble/run-2",
      docType: "PROPOSAL",
    });
    const runId = await startExtractionRun(handle.db, {
      sourceDocumentId: docId,
      model: "m",
      promptVersion: "v1",
    });
    await expect(
      insertStagedRecords(handle.db, runId, [
        { targetMaster: "materials", proposed: materialBundle(), confidence: 0.9 },
        { targetMaster: "materials", proposed: { payloadVersion: 1, material: {} }, confidence: 0.5 },
      ]),
    ).rejects.toThrow(/\[1\]/);
    // Nothing staged (validation happens before insert).
    const rows = await handle.db.select().from(stagedRecords);
    expect(rows).toHaveLength(0);
  });
});

describe("verification queue + reject", () => {
  it("joins staged rows to their document and filters by status/target", async () => {
    await stageOne({ targetMaster: "materials", proposed: materialBundle() });
    await stageOne({ targetMaster: "prices", proposed: pricePoint() });

    const all = await listQueue(handle.db, { status: ["PROPOSED"] });
    expect(all).toHaveLength(2);
    expect(all[0]?.filename).toMatch(/proposal-/);
    expect(all[0]?.sourceDocumentId).toBeTruthy();

    const onlyPrices = await listQueue(handle.db, { targetMaster: "prices" });
    expect(onlyPrices).toHaveLength(1);
    expect(onlyPrices[0]?.targetMaster).toBe("prices");

    const highConf = await listQueue(handle.db, { minConfidence: 0.95 });
    expect(highConf).toHaveLength(0);
  });

  it("reject transitions PROPOSED → REJECTED and refuses a second review", async () => {
    const { stagedId } = await stageOne({ targetMaster: "prices", proposed: pricePoint() });
    await rejectStagedRecord(handle.db, { stagedRecordId: stagedId, reviewer: "rev" });
    const [row] = await handle.db
      .select()
      .from(stagedRecords)
      .where(eq(stagedRecords.id, stagedId));
    expect(row?.status).toBe("REJECTED");
    expect(row?.reviewedBy).toBe("rev");
    await expect(
      rejectStagedRecord(handle.db, { stagedRecordId: stagedId, reviewer: "rev" }),
    ).rejects.toThrow(/already reviewed/);
  });

  it("deleteProposedForDocument removes only PROPOSED rows of the document", async () => {
    const { docId, stagedId } = await stageOne({
      targetMaster: "prices",
      proposed: pricePoint(),
    });
    // A second staged row on the same doc, moved out of PROPOSED.
    await rejectStagedRecord(handle.db, { stagedRecordId: stagedId, reviewer: "rev" });
    const runId = (
      await handle.db
        .select({ id: extractionRuns.id })
        .from(extractionRuns)
        .where(eq(extractionRuns.sourceDocumentId, docId))
    )[0]!.id;
    await insertStagedRecords(handle.db, runId, [
      { targetMaster: "prices", proposed: pricePoint({ sellRupees: 1700 }), confidence: 0.8 },
    ]);

    const deleted = await deleteProposedForDocument(handle.db, docId);
    expect(deleted).toBe(1); // only the still-PROPOSED one
    const remaining = await handle.db.select().from(stagedRecords);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.status).toBe("REJECTED");
  });

  it("listSourceDocuments aggregates staged counts", async () => {
    const { stagedId } = await stageOne({ targetMaster: "materials", proposed: materialBundle() });
    await rejectStagedRecord(handle.db, { stagedRecordId: stagedId, reviewer: "rev" });
    const docs = await listSourceDocuments(handle.db);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.stagedCounts.REJECTED).toBe(1);
    expect(docs[0]?.stagedCounts.PROPOSED).toBe(0);
    expect(docs[0]?.chunkCount).toBe(0);
  });
});

describe("insertHistoricalPrice timeline placement", () => {
  it("empty timeline → new open (current) row", async () => {
    const mk = await freshMake("EMPTY");
    await insertHistoricalPrice(handle.db, {
      materialCode: "FAS-SMK-001",
      makeCode: mk,
      sellPaise: 100000,
      validFrom: T2,
    });
    expect(await timeline("FAS-SMK-001", mk)).toEqual([{ from: T2.toISOString(), to: null }]);
  });

  it("after-latest closes the previously-open row", async () => {
    const mk = await freshMake("AFTER");
    await insertHistoricalPrice(handle.db, { materialCode: "FAS-SMK-001", makeCode: mk, sellPaise: 100000, validFrom: T2 });
    await insertHistoricalPrice(handle.db, { materialCode: "FAS-SMK-001", makeCode: mk, sellPaise: 120000, validFrom: T4 });
    expect(await timeline("FAS-SMK-001", mk)).toEqual([
      { from: T2.toISOString(), to: T4.toISOString() },
      { from: T4.toISOString(), to: null },
    ]);
  });

  it("before-earliest sets valid_to = earliest.valid_from", async () => {
    const mk = await freshMake("BEFORE");
    await insertHistoricalPrice(handle.db, { materialCode: "FAS-SMK-001", makeCode: mk, sellPaise: 100000, validFrom: T2 });
    await insertHistoricalPrice(handle.db, { materialCode: "FAS-SMK-001", makeCode: mk, sellPaise: 90000, validFrom: T1 });
    expect(await timeline("FAS-SMK-001", mk)).toEqual([
      { from: T1.toISOString(), to: T2.toISOString() },
      { from: T2.toISOString(), to: null },
    ]);
  });

  it("between two rows splits the enclosing row", async () => {
    const mk = await freshMake("BETWEEN");
    await insertHistoricalPrice(handle.db, { materialCode: "FAS-SMK-001", makeCode: mk, sellPaise: 100000, validFrom: T2 });
    await insertHistoricalPrice(handle.db, { materialCode: "FAS-SMK-001", makeCode: mk, sellPaise: 130000, validFrom: T4 });
    await insertHistoricalPrice(handle.db, { materialCode: "FAS-SMK-001", makeCode: mk, sellPaise: 115000, validFrom: T3 });
    expect(await timeline("FAS-SMK-001", mk)).toEqual([
      { from: T2.toISOString(), to: T3.toISOString() },
      { from: T3.toISOString(), to: T4.toISOString() },
      { from: T4.toISOString(), to: null },
    ]);
  });

  it("exact-duplicate valid_from surfaces the EXCLUDE constraint error", async () => {
    const mk = await freshMake("DUP");
    await insertHistoricalPrice(handle.db, { materialCode: "FAS-SMK-001", makeCode: mk, sellPaise: 100000, validFrom: T2 });
    await expect(
      insertHistoricalPrice(handle.db, { materialCode: "FAS-SMK-001", makeCode: mk, sellPaise: 105000, validFrom: T2 }),
    ).rejects.toThrow();
  });
});

describe("commitStagedRecord", () => {
  async function auditFor(stagedRecordId: string) {
    const rows = await handle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "STAGED_COMMITTED"));
    return rows.find((r) => (r.payload as Record<string, unknown>).stagedRecordId === stagedRecordId);
  }

  it("commits a materials bundle → material+spec+make+price+install with provenance", async () => {
    const { docId, stagedId } = await stageOne({
      targetMaster: "materials",
      proposed: materialBundle(),
      sourceLocator: { page: 7 },
    });
    const result = await commitStagedRecord(handle.db, {
      stagedRecordId: stagedId,
      reviewer: "reviewer-1",
      decision: "APPROVED",
    });
    expect(result.outcome.kind).toBe("materials");
    expect(result.outcome.degraded).toBe(false);
    const code = result.outcome.materialCode!;
    expect(code).toBe("FAS-DET-950");

    // Material + provenance
    const [mat] = await handle.db.select().from(materials).where(eq(materials.materialCode, code));
    expect(mat?.materialName).toBe("Beacon Sounder Combo Unit X900");
    const prov = sourceProvenanceSchema.parse(mat?.sourceProvenance);
    expect(prov.sourceDocumentId).toBe(docId);
    expect(prov.committedBy).toBe("reviewer-1");
    expect(prov.page).toBe(7);
    expect(prov.promptVersion).toBe("extract-v3");

    // Spec (from specSummary)
    const [spec] = await handle.db
      .select()
      .from(materialSpecs)
      .where(eq(materialSpecs.materialCode, code));
    expect(spec?.complianceNotes).toContain("Combined beacon");

    // Make with provenance
    const [mk] = await handle.db.select().from(makes).where(eq(makes.makeCode, result.outcome.makeCode!));
    expect(mk?.brandName).toBe("Agni Devices");
    expect(() => sourceProvenanceSchema.parse(mk?.sourceProvenance)).not.toThrow();

    // Price (5000 rupees → 500000 paise) with provenance
    const [price] = await handle.db.select().from(prices).where(eq(prices.priceId, result.outcome.priceId!));
    expect(price?.sellingRate).toBe("5000.00");
    expect(() => sourceProvenanceSchema.parse(price?.sourceProvenance)).not.toThrow();

    // Install rate with provenance
    const [ir] = await handle.db
      .select()
      .from(installRates)
      .where(eq(installRates.id, result.outcome.installRateId!));
    expect(ir?.rateCode).toBe("INST-FAS-DET-950");
    expect(() => sourceProvenanceSchema.parse(ir?.sourceProvenance)).not.toThrow();

    // Staged row advanced + audit present
    const [staged] = await handle.db.select().from(stagedRecords).where(eq(stagedRecords.id, stagedId));
    expect(staged?.status).toBe("APPROVED");
    expect(staged?.reviewedBy).toBe("reviewer-1");
    const audit = await auditFor(stagedId);
    expect(audit).toBeTruthy();
    expect((audit!.payload as Record<string, unknown>).materialCode).toBe(code);
  });

  it("commits a price-point onto an existing make (temporal supersede)", async () => {
    const { stagedId } = await stageOne({ targetMaster: "prices", proposed: pricePoint() });
    const result = await commitStagedRecord(handle.db, {
      stagedRecordId: stagedId,
      reviewer: "rev",
      decision: "APPROVED",
    });
    expect(result.outcome.kind).toBe("prices");
    expect(result.outcome.makeCode).toBe("FAS-HEAT-001-AGNI"); // reused existing make
    // The seed row [2024-01-01, ∞) is closed at 2025-03-01; the committed row is now current.
    const openRows = await handle.db
      .select()
      .from(prices)
      .where(eq(prices.makeCode, "FAS-HEAT-001-AGNI"))
      .orderBy(asc(prices.validFrom));
    expect(openRows).toHaveLength(2);
    const current = openRows.find((r) => r.validTo === null);
    expect(current?.sellingRate).toBe("1500.00");
    expect(current?.priceId).toBe(result.outcome.priceId);
  });

  it("EDITED_APPROVED merges edits and records editedFields", async () => {
    const { stagedId } = await stageOne({
      targetMaster: "prices",
      proposed: pricePoint({ sellRupees: 1500 }),
    });
    const result = await commitStagedRecord(handle.db, {
      stagedRecordId: stagedId,
      reviewer: "rev",
      decision: "EDITED_APPROVED",
      edits: { sellRupees: 2000 },
    });
    const openRows = await handle.db
      .select()
      .from(prices)
      .where(eq(prices.priceId, result.outcome.priceId!));
    expect(openRows[0]?.sellingRate).toBe("2000.00");
    const [staged] = await handle.db.select().from(stagedRecords).where(eq(stagedRecords.id, stagedId));
    expect(staged?.status).toBe("EDITED_APPROVED");
    const rows = await handle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "STAGED_COMMITTED"));
    const audit = rows.find((r) => (r.payload as Record<string, unknown>).stagedRecordId === stagedId);
    expect((audit!.payload as { editedFields: string[] }).editedFields).toContain("sellRupees");
  });

  it("commits a make-link and an install-rate", async () => {
    const mkStage = await stageOne({
      targetMaster: "makes",
      proposed: {
        payloadVersion: 1,
        materialCode: "FAS-SMK-001",
        brandName: { raw: "Bosch", normalized: "Bosch" },
        tier: "Premium",
        sourceText: "Bosch smoke detector approved make",
      },
    });
    const mkResult = await commitStagedRecord(handle.db, {
      stagedRecordId: mkStage.stagedId,
      reviewer: "rev",
      decision: "APPROVED",
    });
    expect(mkResult.outcome.kind).toBe("makes");
    const [mk] = await handle.db.select().from(makes).where(eq(makes.makeCode, mkResult.outcome.makeCode!));
    expect(mk?.brandName).toBe("Bosch");

    const irStage = await stageOne({
      targetMaster: "install_rates",
      proposed: {
        payloadVersion: 1,
        materialCode: "FAS-MCP-001",
        systemType: "FAS",
        unit: "Per No.",
        rupees: 450,
        sourceText: "MCP installation labour",
      },
    });
    const irResult = await commitStagedRecord(handle.db, {
      stagedRecordId: irStage.stagedId,
      reviewer: "rev",
      decision: "APPROVED",
    });
    expect(irResult.outcome.kind).toBe("install_rates");
    const [ir] = await handle.db
      .select()
      .from(installRates)
      .where(eq(installRates.id, irResult.outcome.installRateId!));
    expect(ir?.rateCode).toBe("INST-FAS-MCP-001");
  });

  it("degrades a duplicate material bundle to a price-point on the matched code", async () => {
    const first = await stageOne({
      targetMaster: "materials",
      proposed: materialBundle({
        material: {
          materialCode: "FAS-ACC-800",
          materialName: "Quartz Marker Beacon Assembly QT",
          systemType: "FAS",
          category: "Accessory",
          unitOfMeasure: { raw: "Nos", normalized: "No." },
        },
        make: { brandName: { raw: "Alpha Corp", normalized: "Alpha Corp" }, tier: "Standard" },
        price: { sellRupees: 4000, buyRupees: 3000, rateKind: "SUPPLY", validFromISO: "2025-01-01T00:00:00.000Z" },
        installRate: null,
      }),
    });
    const firstResult = await commitStagedRecord(handle.db, {
      stagedRecordId: first.stagedId,
      reviewer: "rev",
      decision: "APPROVED",
    });
    expect(firstResult.outcome.degraded).toBe(false);
    const createdCode = firstResult.outcome.materialCode!;

    const second = await stageOne({
      targetMaster: "materials",
      proposed: materialBundle({
        material: {
          materialCode: "FAS-ACC-801",
          materialName: "Quartz Marker Beacon Assembly QTX",
          systemType: "FAS",
          category: "Accessory",
          unitOfMeasure: { raw: "Nos", normalized: "No." },
        },
        make: { brandName: { raw: "Beta Corp", normalized: "Beta Corp" }, tier: "Standard" },
        price: { sellRupees: 4200, buyRupees: 3200, rateKind: "SUPPLY", validFromISO: "2025-05-01T00:00:00.000Z" },
        installRate: null,
      }),
    });
    const secondResult = await commitStagedRecord(handle.db, {
      stagedRecordId: second.stagedId,
      reviewer: "rev",
      decision: "APPROVED",
    });
    expect(secondResult.outcome.degraded).toBe(true);
    expect(secondResult.outcome.kind).toBe("prices");
    expect(secondResult.outcome.materialCode).toBe(createdCode);
    // No new material row was created for the duplicate.
    const dupMat = await handle.db
      .select()
      .from(materials)
      .where(eq(materials.materialCode, "FAS-ACC-801"));
    expect(dupMat).toHaveLength(0);
  });

  it("rolls back completely when a late step fails (bad embedding dimension)", async () => {
    const { stagedId } = await stageOne({ targetMaster: "materials", proposed: materialBundle() });
    const before = {
      materials: (await handle.db.select().from(materials)).length,
      makes: (await handle.db.select().from(makes)).length,
      prices: (await handle.db.select().from(prices)).length,
    };
    await expect(
      commitStagedRecord(handle.db, {
        stagedRecordId: stagedId,
        reviewer: "rev",
        decision: "APPROVED",
        nameEmbedding: [1, 2, 3], // wrong dimension → fails after the master writes
        embeddingModel: "bad",
      }),
    ).rejects.toThrow();
    expect((await handle.db.select().from(materials)).length).toBe(before.materials);
    expect((await handle.db.select().from(makes)).length).toBe(before.makes);
    expect((await handle.db.select().from(prices)).length).toBe(before.prices);
    const [staged] = await handle.db.select().from(stagedRecords).where(eq(stagedRecords.id, stagedId));
    expect(staged?.status).toBe("PROPOSED"); // untouched
    const audit = await handle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "STAGED_COMMITTED"));
    expect(audit).toHaveLength(0);
  });

  it("throws (and persists nothing) on a bad mergeIntoCode", async () => {
    const { stagedId } = await stageOne({ targetMaster: "materials", proposed: materialBundle() });
    const before = (await handle.db.select().from(materials)).length;
    await expect(
      commitStagedRecord(handle.db, {
        stagedRecordId: stagedId,
        reviewer: "rev",
        decision: "MERGED",
        mergeIntoCode: "NON-EXISTENT-999",
      }),
    ).rejects.toThrow(/does not exist/);
    expect((await handle.db.select().from(materials)).length).toBe(before);
  });
});
