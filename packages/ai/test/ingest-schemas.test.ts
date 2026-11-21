import { describe, expect, it } from "vitest";
import { docMetaSchema, extractedLineSchema, pageLinesSchema } from "../src/index";

function validDocMeta() {
  return {
    clientName: "Yara Northwind",
    projectName: "COMMERCIAL UNIT, LAKEVIEW LABS BUILDING, LUCKNOW, UP",
    attention: "Yara Northwind",
    docDateISO: "2025-12-26",
    revision: "02",
    sourceEntityGuess: "Greenberg Enterprises",
    docKind: "proposal" as const,
    systemsMentioned: ["Sprinkler", "FAS"],
    sections: [
      { title: "A. SPRINKLER SYSTEM", systemGuess: "Sprinkler" },
      { title: "PART II. ALARMS & ASSITANCE", systemGuess: "FAS" },
    ],
    grandTotalRupees: 83909.8,
    gstMentioned: true,
    summary: "A fire-safety proposal for a sprinkler + FAS system.",
  };
}

function validLine() {
  return {
    slNo: "A1",
    description: "SITC M.S. Pipe Class 'C' 50 mm - For Sprinkler Main Central Branch; Make - Jindal (ISI)",
    makeRaw: "Jindal (ISI)",
    qty: 6,
    unitRaw: "mtr",
    unitRateRupees: 590,
    rateKind: "SITC" as const,
    amountRupees: 3540,
    section: "A. SPRINKLER SYSTEM",
    page: 1,
    confidence: 0.95,
  };
}

describe("docMetaSchema", () => {
  it("accepts a fully populated valid object", () => {
    const parsed = docMetaSchema.safeParse(validDocMeta());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it("accepts all-null optional fields (a silent document)", () => {
    const parsed = docMetaSchema.safeParse({
      clientName: null,
      projectName: null,
      attention: null,
      docDateISO: null,
      revision: null,
      sourceEntityGuess: null,
      docKind: "other",
      systemsMentioned: [],
      sections: [],
      grandTotalRupees: null,
      gstMentioned: null,
      summary: "Nothing legible.",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a malformed docDateISO", () => {
    const parsed = docMetaSchema.safeParse({ ...validDocMeta(), docDateISO: "26-12-2025" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown docKind", () => {
    const parsed = docMetaSchema.safeParse({ ...validDocMeta(), docKind: "quotation" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a missing summary", () => {
    const { summary: _summary, ...rest } = validDocMeta();
    const parsed = docMetaSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty-string summary", () => {
    const parsed = docMetaSchema.safeParse({ ...validDocMeta(), summary: "" });
    expect(parsed.success).toBe(false);
  });
});

describe("extractedLineSchema", () => {
  it("accepts a fully populated valid line", () => {
    const parsed = extractedLineSchema.safeParse(validLine());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it("accepts a line with every optional-ish field null", () => {
    const parsed = extractedLineSchema.safeParse({
      slNo: null,
      description: "Unreadable row",
      makeRaw: null,
      qty: null,
      unitRaw: null,
      unitRateRupees: null,
      rateKind: "UNKNOWN",
      amountRupees: null,
      section: null,
      page: 3,
      confidence: 0.1,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty description", () => {
    const parsed = extractedLineSchema.safeParse({ ...validLine(), description: "" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-positive page", () => {
    const parsed = extractedLineSchema.safeParse({ ...validLine(), page: 0 });
    expect(parsed.success).toBe(false);
  });

  it("rejects a rateKind outside the shared STAGED_RATE_KINDS enum", () => {
    const parsed = extractedLineSchema.safeParse({ ...validLine(), rateKind: "DISCOUNT" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a confidence outside [0,1]", () => {
    const parsed = extractedLineSchema.safeParse({ ...validLine(), confidence: 1.5 });
    expect(parsed.success).toBe(false);
  });
});

describe("pageLinesSchema", () => {
  it("accepts an empty page window (no line items, no terms)", () => {
    const parsed = pageLinesSchema.safeParse({ lines: [], termsText: null });
    expect(parsed.success).toBe(true);
  });

  it("accepts multiple lines plus terms text", () => {
    const parsed = pageLinesSchema.safeParse({
      lines: [validLine(), { ...validLine(), slNo: "A2", page: 1 }],
      termsText: "Payment: 15% advance, balance on delivery.",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.lines).toHaveLength(2);
  });

  it("rejects a window whose lines array contains an invalid line", () => {
    const parsed = pageLinesSchema.safeParse({
      lines: [{ ...validLine(), page: -1 }],
      termsText: null,
    });
    expect(parsed.success).toBe(false);
  });
});
