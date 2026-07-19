import { formatINR } from "@pebble/shared";
import { describe, expect, it } from "vitest";
import { buildChunks, type BuildChunksArgs, type ChunkDocMeta } from "../src/ingest/chunks";
import type { NormalizedLine } from "../src/ingest/normalize";

function normLine(overrides: Partial<NormalizedLine> = {}): NormalizedLine {
  return {
    slNo: "A1",
    description: "SITC of Something",
    makeRaw: "Jindal (ISI)",
    qty: 10,
    unitRaw: "mtr",
    unitRateRupees: 100,
    rateKind: "SITC",
    amountRupees: 1000,
    section: "A. SECTION ONE",
    page: 3,
    confidence: 1,
    unit: { raw: "mtr", normalized: "Metre" },
    brand: { raw: "Jindal (ISI)", normalized: "Jindal", alternatives: ["Jindal (ISI)"] },
    sellPaise: 10000,
    amountPaise: 100000,
    crossCheck: "ok",
    systemGuess: "Hydrant",
    categoryGuess: "Pipe",
    warnings: [],
    ...overrides,
  };
}

function baseMeta(overrides: Partial<ChunkDocMeta> = {}): ChunkDocMeta {
  return {
    clientName: "Acme Towers",
    projectName: "Acme Commercial Tower",
    docDateISO: "2024-11-09",
    revision: "R0",
    sourceEntity: "Greenberg Enterprises",
    docKind: "PDF",
    summary: "A proposal for active fire fighting works at Acme Commercial Tower.",
    systems: ["Hydrant", "Sprinkler"],
    grandTotalPaise: 500000000,
    ...overrides,
  };
}

function baseArgs(overrides: Partial<BuildChunksArgs> = {}): BuildChunksArgs {
  return {
    meta: baseMeta(),
    lines: [normLine()],
    termsText: null,
    fileRef: "FF-01",
    filename: "FF-01 Acme Tower (09112024 R0).pdf",
    docType: "pdf",
    ...overrides,
  };
}

describe("buildChunks — doc_summary", () => {
  it("always emits exactly one doc_summary chunk carrying the summary + key facts", () => {
    const chunks = buildChunks(baseArgs());
    const summaries = chunks.filter((c) => c.chunkKind === "doc_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.content).toContain("A proposal for active fire fighting works");
    expect(summaries[0]!.content).toContain("Acme Towers");
    expect(summaries[0]!.content).toContain("Hydrant, Sprinkler");
  });
});

describe("buildChunks — boq_section grouping and splitting", () => {
  it("groups lines by section, falling back to systemGuess then UNSECTIONED", () => {
    const lines = [
      normLine({ section: "A. SECTION ONE", slNo: "A1" }),
      normLine({ section: null, systemGuess: "Sprinkler", slNo: "B1" }),
      normLine({ section: null, systemGuess: null, slNo: "C1" }),
    ];
    const chunks = buildChunks(baseArgs({ lines }));
    const sections = chunks
      .filter((c) => c.chunkKind === "boq_section")
      .map((c) => c.metadata.section);
    expect(sections).toEqual(["A. SECTION ONE", "Sprinkler", "UNSECTIONED"]);
  });

  it("splits a section into multiple chunks at 40 lines", () => {
    const lines = Array.from({ length: 45 }, (_, i) =>
      normLine({ slNo: `A${i + 1}`, section: "A. BIG SECTION", description: `Item number ${i + 1}` }),
    );
    const chunks = buildChunks(baseArgs({ lines })).filter((c) => c.chunkKind === "boq_section");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.metadata.lineCount).toBe(40);
    expect(chunks[1]!.metadata.lineCount).toBe(5);
    // Every line accounted for, none duplicated.
    const totalLines = chunks.reduce((s, c) => s + (c.metadata.lineCount as number), 0);
    expect(totalLines).toBe(45);
  });

  it("does not split a section under the 40-line cap", () => {
    const lines = Array.from({ length: 10 }, (_, i) => normLine({ slNo: `A${i + 1}`, section: "A. SMALL" }));
    const chunks = buildChunks(baseArgs({ lines })).filter((c) => c.chunkKind === "boq_section");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.metadata.lineCount).toBe(10);
  });

  it("splits further when content would exceed the 6000-char hard cap, even under 40 lines", () => {
    const longDescription = "X".repeat(500);
    const lines = Array.from({ length: 20 }, (_, i) =>
      normLine({ slNo: `A${i + 1}`, section: "A. LONG LINES", description: longDescription }),
    );
    const chunks = buildChunks(baseArgs({ lines })).filter((c) => c.chunkKind === "boq_section");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(6000);
    }
    const totalLines = chunks.reduce((s, c) => s + (c.metadata.lineCount as number), 0);
    expect(totalLines).toBe(20);
  });

  it("computes pageStart/pageEnd, systems and sectionTotalPaise metadata", () => {
    const lines = [
      normLine({ slNo: "A1", section: "A. SEC", page: 2, systemGuess: "Hydrant", amountPaise: 100000 }),
      normLine({ slNo: "A2", section: "A. SEC", page: 4, systemGuess: "Sprinkler", amountPaise: 200000 }),
      normLine({ slNo: "A3", section: "A. SEC", page: 3, systemGuess: "Hydrant", amountPaise: null }),
    ];
    const chunks = buildChunks(baseArgs({ lines })).filter((c) => c.chunkKind === "boq_section");
    expect(chunks).toHaveLength(1);
    const meta = chunks[0]!.metadata;
    expect(meta.pageStart).toBe(2);
    expect(meta.pageEnd).toBe(4);
    expect(meta.systems).toEqual(["Hydrant", "Sprinkler"]);
    expect(meta.sectionTotalPaise).toBe(300000);
    expect(meta.lineCount).toBe(3);
  });

  it("pageStart/pageEnd are 0 for xlsx-sourced lines (page: 0)", () => {
    const lines = [normLine({ page: 0 }), normLine({ page: 0, slNo: "A2" })];
    const chunks = buildChunks(baseArgs({ lines })).filter((c) => c.chunkKind === "boq_section");
    expect(chunks[0]!.metadata).toMatchObject({ pageStart: 0, pageEnd: 0 });
  });

  it("renders lines as 'Sl | description — make | qty unit @ ₹rate = ₹amount'", () => {
    const l = normLine({
      slNo: "A7",
      description: "SITC Butterfly Valve",
      brand: { raw: "Kartar", normalized: "Kartar", alternatives: ["Kartar"] },
      qty: 5,
      unit: { raw: "pcs", normalized: "No." },
      sellPaise: 560000,
      amountPaise: 2800000,
    });
    const chunks = buildChunks(baseArgs({ lines: [l] })).filter((c) => c.chunkKind === "boq_section");
    const expectedLine = `A7 | SITC Butterfly Valve — Kartar | 5 No. @ ${formatINR(560000)} = ${formatINR(2800000)}`;
    expect(chunks[0]!.content).toBe(expectedLine);
  });
});

describe("buildChunks — terms", () => {
  it("omits the terms chunk when termsText is null or blank", () => {
    expect(buildChunks(baseArgs({ termsText: null })).some((c) => c.chunkKind === "terms")).toBe(false);
    expect(buildChunks(baseArgs({ termsText: "   " })).some((c) => c.chunkKind === "terms")).toBe(false);
  });

  it("emits exactly one terms chunk when termsText is present", () => {
    const chunks = buildChunks(baseArgs({ termsText: "1. Payment terms.\n2. Validity 7 days." }));
    const terms = chunks.filter((c) => c.chunkKind === "terms");
    expect(terms).toHaveLength(1);
    expect(terms[0]!.content).toContain("Payment terms");
  });

  it("caps terms content to ~400 words", () => {
    const longTerms = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
    const chunks = buildChunks(baseArgs({ termsText: longTerms }));
    const terms = chunks.find((c) => c.chunkKind === "terms")!;
    expect(terms.content.split(/\s+/).length).toBeLessThanOrEqual(400);
  });
});

describe("buildChunks — metadata completeness", () => {
  const commonFieldsExceptSystems = {
    fileRef: "FF-01",
    filename: "FF-01 Acme Tower (09112024 R0).pdf",
    docType: "pdf",
    docDateISO: "2024-11-09",
    revision: "R0",
    sourceEntity: "Greenberg Enterprises",
    client: "Acme Towers",
    project: "Acme Commercial Tower",
    grandTotalPaise: 500000000,
  };

  it("every chunk carries the common (doc-level) metadata fields", () => {
    const chunks = buildChunks(baseArgs({ termsText: "Terms text here.", lines: [normLine()] }));
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.metadata).toMatchObject(commonFieldsExceptSystems);
    }
  });

  it("doc_summary and terms carry the doc-level systems list verbatim", () => {
    const chunks = buildChunks(baseArgs({ termsText: "Terms text here.", lines: [normLine()] }));
    for (const c of chunks) {
      if (c.chunkKind === "boq_section") continue; // boq_section's `systems` is section-local, asserted separately.
      expect(c.metadata.systems).toEqual(["Hydrant", "Sprinkler"]);
    }
  });

  it("hard-caps every chunk's content at 6000 chars", () => {
    const chunks = buildChunks(
      baseArgs({ termsText: "word ".repeat(5000), lines: Array.from({ length: 5 }, () => normLine()) }),
    );
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(6000);
    }
  });
});
