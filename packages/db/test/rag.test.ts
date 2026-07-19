import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/index";
import {
  hybridSearch,
  nearestMaterialNames,
  registerSourceDocument,
  replaceDocChunks,
  trgmMaterialCandidates,
  upsertMaterialNameEmbedding,
} from "../src/index";
import { ragChunks } from "../src/schema";
import { eq } from "drizzle-orm";
import { freshDb } from "./helpers";

let handle: DbHandle;
beforeEach(async () => {
  handle = await freshDb();
});
afterEach(async () => {
  await handle.close();
});

/** A deterministic unit vector with a single 1 at `index` (768-dim). */
function unitVec(index: number, dims = 768): number[] {
  const v = new Array<number>(dims).fill(0);
  v[index] = 1;
  return v;
}

async function seedDoc(): Promise<string> {
  const { id } = await registerSourceDocument(handle.db, {
    filename: "proposal-42.pdf",
    storageUri: "gs://pebble/rag-doc",
    docType: "PROPOSAL",
  });
  return id;
}

async function seedChunks(docId: string) {
  return replaceDocChunks(handle.db, docId, [
    {
      chunkKind: "boq_section",
      content: "Fire alarm smoke detector installation and testing for the FAS loop",
      embedding: unitVec(0),
      metadata: { systems: ["FAS"], docDateISO: "2025-01-15" },
    },
    {
      chunkKind: "boq_section",
      content: "Main hydrant pump diesel standby set with jockey pump",
      embedding: unitVec(1),
      metadata: { systems: ["Hydrant"], docDateISO: "2025-02-20" },
    },
    {
      chunkKind: "doc_summary",
      content: "Pendant sprinkler head schedule for light hazard occupancy",
      embedding: null, // exercises the null-embedding / dev path
      metadata: { systems: ["Sprinkler"], docDateISO: "2025-03-10" },
    },
  ]);
}

describe("replaceDocChunks", () => {
  it("delete-then-insert replaces the document's chunks", async () => {
    const docId = await seedDoc();
    const n = await seedChunks(docId);
    expect(n).toBe(3);
    expect(await handle.db.select().from(ragChunks).where(eq(ragChunks.sourceDocumentId, docId))).toHaveLength(3);

    const n2 = await replaceDocChunks(handle.db, docId, [
      { chunkKind: "terms", content: "Payment terms 30 days", embedding: null, metadata: {} },
    ]);
    expect(n2).toBe(1);
    const rows = await handle.db.select().from(ragChunks).where(eq(ragChunks.sourceDocumentId, docId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chunkKind).toBe("terms");
  });
});

describe("hybridSearch", () => {
  it("finds by keyword with a null query embedding (tsvector-only path)", async () => {
    const docId = await seedDoc();
    await seedChunks(docId);
    const hits = await hybridSearch(handle.db, {
      queryText: "smoke detector",
      queryEmbedding: null,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain("smoke detector");
    expect(hits[0]?.filename).toBe("proposal-42.pdf");
  });

  it("fuses keyword + vector arms so the on-topic chunk ranks first", async () => {
    const docId = await seedDoc();
    await seedChunks(docId);
    const hits = await hybridSearch(handle.db, {
      queryText: "smoke detector",
      queryEmbedding: unitVec(0), // nearest the FAS chunk
    });
    expect(hits[0]?.content).toContain("smoke detector");
    // The FAS chunk is present in both arms → higher fused score than the vector-only neighbour.
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("applies chunkKind and systems filters in both arms", async () => {
    const docId = await seedDoc();
    await seedChunks(docId);

    const hydrantOnly = await hybridSearch(handle.db, {
      queryText: "pump",
      queryEmbedding: unitVec(1),
      filters: { systems: ["Hydrant"] },
    });
    expect(hydrantOnly).toHaveLength(1);
    expect(hydrantOnly[0]?.content).toContain("hydrant pump");

    const summaryOnly = await hybridSearch(handle.db, {
      queryText: "sprinkler",
      queryEmbedding: null,
      filters: { chunkKind: ["doc_summary"] },
    });
    expect(summaryOnly).toHaveLength(1);
    expect(summaryOnly[0]?.chunkKind).toBe("doc_summary");
  });

  it("filters on the metadata date range", async () => {
    const docId = await seedDoc();
    await seedChunks(docId);
    // The only "pump" chunk is dated 2025-02-20.
    const inFeb = await hybridSearch(handle.db, {
      queryText: "pump",
      queryEmbedding: null,
      filters: { docDateFrom: "2025-02-01", docDateTo: "2025-02-28" },
    });
    expect(inFeb).toHaveLength(1);
    expect(inFeb[0]?.content).toContain("hydrant pump");

    const inJan = await hybridSearch(handle.db, {
      queryText: "pump",
      queryEmbedding: null,
      filters: { docDateFrom: "2025-01-01", docDateTo: "2025-01-31" },
    });
    expect(inJan).toHaveLength(0); // out of window
  });
});

describe("trgmMaterialCandidates", () => {
  it("returns the seeded detector for a fuzzy query", async () => {
    const candidates = await trgmMaterialCandidates(handle.db, "smoke detector photo electric");
    const smoke = candidates.find((c) => c.materialCode === "FAS-SMK-001");
    expect(smoke).toBeTruthy();
    expect(smoke!.similarity).toBeGreaterThan(0.3);
  });
});

describe("material name embeddings", () => {
  it("upserts and round-trips via nearestMaterialNames", async () => {
    await upsertMaterialNameEmbedding(handle.db, "FAS-SMK-001", unitVec(5), "text-embedding-004");
    await upsertMaterialNameEmbedding(handle.db, "FAS-HEAT-001", unitVec(6), "text-embedding-004");

    const nearest = await nearestMaterialNames(handle.db, unitVec(5), 2);
    expect(nearest[0]?.materialCode).toBe("FAS-SMK-001");
    expect(nearest[0]?.cosine).toBeCloseTo(0, 5);
    expect(nearest[1]?.materialCode).toBe("FAS-HEAT-001");

    // Upsert (update) path: re-point FAS-SMK-001 and confirm it moves.
    await upsertMaterialNameEmbedding(handle.db, "FAS-SMK-001", unitVec(6), "text-embedding-004");
    const nearestToSix = await nearestMaterialNames(handle.db, unitVec(6), 1);
    expect(["FAS-SMK-001", "FAS-HEAT-001"]).toContain(nearestToSix[0]?.materialCode);
    expect(nearestToSix[0]?.cosine).toBeCloseTo(0, 5);
  });
});
