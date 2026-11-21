import { describe, expect, it } from "vitest";
import { matchLine, scoreExtraction, type EvalExpectation, type ExpectedLine } from "../src/index";
import type { DocMeta, ExtractedLine } from "../src/index";

function line(overrides: Partial<ExtractedLine> = {}): ExtractedLine {
  return {
    slNo: "A1",
    description: "SITC M.S. Pipe Class 'C' 50 mm - For Sprinkler Main Central Branch; Make - Jindal (ISI)",
    makeRaw: "Jindal (ISI)",
    qty: 6,
    unitRaw: "mtr",
    unitRateRupees: 590,
    rateKind: "SITC",
    amountRupees: 3540,
    section: "A. SPRINKLER SYSTEM",
    page: 1,
    confidence: 0.9,
    ...overrides,
  };
}

function expected(overrides: Partial<ExpectedLine> = {}): ExpectedLine {
  return {
    page: 1,
    slNo: "A1",
    descriptionContains: "class 'c' 50 mm",
    makeRaw: "Jindal (ISI)",
    qty: 6,
    unitRaw: "mtr",
    unitRateRupees: 590,
    amountRupees: 3540,
    rateKind: "SITC",
    section: "A. SPRINKLER SYSTEM",
    ...overrides,
  };
}

describe("matchLine", () => {
  it("matches when page/qty/rate/description all agree", () => {
    expect(matchLine(expected(), line())).toBe(true);
  });

  it("is case- and whitespace-insensitive on the description substring", () => {
    expect(
      matchLine(
        expected({ descriptionContains: "  CLASS 'C'   50 MM  " }),
        line({ description: "SITC M.S. Pipe Class 'C' 50 mm - For Sprinkler\nMain Central Branch" }),
      ),
    ).toBe(true);
  });

  it("rejects a different page", () => {
    expect(matchLine(expected({ page: 1 }), line({ page: 2 }))).toBe(false);
  });

  it("rejects a different qty when expected.qty is given", () => {
    expect(matchLine(expected({ qty: 6 }), line({ qty: 7 }))).toBe(false);
  });

  it("ignores qty when expected.qty is null/undefined", () => {
    expect(matchLine(expected({ qty: null }), line({ qty: 999 }))).toBe(true);
    const { qty: _qty, ...withoutQty } = expected();
    expect(matchLine(withoutQty, line({ qty: 999 }))).toBe(true);
  });

  it("accepts a rate within the 0.5% tolerance boundary", () => {
    // 0.5% of 1000 = 5.00 exactly -> boundary should still match.
    expect(matchLine(expected({ unitRateRupees: 1000 }), line({ unitRateRupees: 1005 }))).toBe(true);
    expect(matchLine(expected({ unitRateRupees: 1000 }), line({ unitRateRupees: 995 }))).toBe(true);
  });

  it("rejects a rate just outside the 0.5% tolerance boundary", () => {
    expect(matchLine(expected({ unitRateRupees: 1000 }), line({ unitRateRupees: 1005.01 }))).toBe(false);
    expect(matchLine(expected({ unitRateRupees: 1000 }), line({ unitRateRupees: 994.99 }))).toBe(false);
  });

  it("rejects when expected rate is set but actual rate is null", () => {
    expect(matchLine(expected({ unitRateRupees: 590 }), line({ unitRateRupees: null }))).toBe(false);
  });

  it("rejects when the description does not contain the expected substring", () => {
    expect(matchLine(expected({ descriptionContains: "hydrant valve" }), line())).toBe(false);
  });
});

describe("scoreExtraction", () => {
  it("scores a perfect match as precision=1, recall=1, no mismatches", () => {
    const expectation: EvalExpectation = { labeledPages: [1], expectedLines: [expected()] };
    const result = scoreExtraction(expectation, { meta: null, lines: [line()] });
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.expectedCount).toBe(1);
    expect(result.extractedOnLabeledPages).toBe(1);
    expect(result.mismatches).toEqual([]);
    expect(result.fieldAccuracy).toEqual({ make: 1, unit: 1, rateKind: 1 });
  });

  it("scores a wrong-page extraction as a full miss (recall drops, mismatch recorded)", () => {
    const expectation: EvalExpectation = { labeledPages: [1], expectedLines: [expected({ page: 1 })] };
    const result = scoreExtraction(expectation, { meta: null, lines: [line({ page: 2 })] });
    expect(result.matched).toBe(0);
    expect(result.recall).toBe(0);
    // The wrong-page line isn't on a labeled page, so it doesn't count against precision either.
    expect(result.extractedOnLabeledPages).toBe(0);
    expect(result.precision).toBe(0);
    expect(result.mismatches.some((m) => m.startsWith("missing:"))).toBe(true);
  });

  it("drops precision (not recall) when an extra unexpected line is extracted on a labeled page", () => {
    const expectation: EvalExpectation = { labeledPages: [1], expectedLines: [expected()] };
    const extra = line({ slNo: "A2", description: "an unrelated extra row", qty: 1, unitRateRupees: 100 });
    const result = scoreExtraction(expectation, { meta: null, lines: [line(), extra] });
    expect(result.recall).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.extractedOnLabeledPages).toBe(2);
    expect(result.precision).toBeCloseTo(0.5, 10);
    expect(result.mismatches.some((m) => m.startsWith("extra:") && m.includes("unrelated extra row"))).toBe(true);
  });

  it("drops recall (not precision) when an expected line is missing from the extraction", () => {
    const expectation: EvalExpectation = {
      labeledPages: [1],
      expectedLines: [expected(), expected({ slNo: "A2", descriptionContains: "hydrant valve" })],
    };
    const result = scoreExtraction(expectation, { meta: null, lines: [line()] });
    expect(result.matched).toBe(1);
    expect(result.expectedCount).toBe(2);
    expect(result.recall).toBeCloseTo(0.5, 10);
    expect(result.precision).toBe(1);
    expect(result.mismatches.some((m) => m.startsWith("missing:") && m.includes("hydrant valve"))).toBe(true);
  });

  it("does not penalize precision for extra lines on an unlabeled page", () => {
    const expectation: EvalExpectation = { labeledPages: [1], expectedLines: [expected()] };
    const unlabeledExtra = line({ page: 2, slNo: "B1" });
    const result = scoreExtraction(expectation, { meta: null, lines: [line(), unlabeledExtra] });
    expect(result.precision).toBe(1);
    expect(result.extractedOnLabeledPages).toBe(1);
  });

  it("records field-accuracy mismatches for make/unit/rateKind without failing the line match", () => {
    const expectation: EvalExpectation = { labeledPages: [1], expectedLines: [expected()] };
    const actual = line({ makeRaw: "Ravel", unitRaw: "mt", rateKind: "SUPPLY" });
    const result = scoreExtraction(expectation, { meta: null, lines: [actual] });
    expect(result.matched).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.fieldAccuracy).toEqual({ make: 0, unit: 0, rateKind: 0 });
    expect(result.mismatches.some((m) => m.startsWith("make mismatch"))).toBe(true);
    expect(result.mismatches.some((m) => m.startsWith("unit mismatch"))).toBe(true);
    expect(result.mismatches.some((m) => m.startsWith("rateKind mismatch"))).toBe(true);
  });

  it("skips field-accuracy checks for fields the label omits", () => {
    const expectation: EvalExpectation = {
      labeledPages: [1],
      expectedLines: [{ page: 1, descriptionContains: "class 'c' 50 mm" }],
    };
    const result = scoreExtraction(expectation, { meta: null, lines: [line({ makeRaw: "anything at all" })] });
    expect(result.matched).toBe(1);
    expect(result.fieldAccuracy).toEqual({ make: 1, unit: 1, rateKind: 1 });
    expect(result.mismatches).toEqual([]);
  });

  it("treats an empty expectation with no extracted lines as a perfect (vacuous) score", () => {
    const expectation: EvalExpectation = { labeledPages: [1], expectedLines: [] };
    const result = scoreExtraction(expectation, { meta: null, lines: [] });
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
  });

  it("compares scalar expectMeta fields case-insensitively and reports mismatches", () => {
    const meta: DocMeta = {
      clientName: null,
      projectName: "COMMERCIAL UNIT, LAKEVIEW LABS BUILDING, LUCKNOW, UP",
      attention: "yara northwind", // model returned lowercase — should still match
      docDateISO: "2025-12-26",
      revision: "02",
      sourceEntityGuess: "Greenberg Enterprises",
      docKind: "estimate", // wrong on purpose
      systemsMentioned: [],
      sections: [],
      grandTotalRupees: 83909.8,
      gstMentioned: true,
      summary: "x",
    };
    const expectation: EvalExpectation = {
      labeledPages: [1],
      expectedLines: [],
      expectMeta: {
        attention: "Yara Northwind",
        docKind: "proposal",
        grandTotalRupees: 83909.8,
      },
    };
    const result = scoreExtraction(expectation, { meta, lines: [] });
    expect(result.metaAccuracy).toEqual({ attention: true, docKind: false, grandTotalRupees: true });
    expect(result.mismatches.some((m) => m.startsWith("meta.docKind mismatch"))).toBe(true);
  });

  it("marks every expectMeta field false when no meta was extracted", () => {
    const expectation: EvalExpectation = {
      labeledPages: [1],
      expectedLines: [],
      expectMeta: { docKind: "proposal" },
    };
    const result = scoreExtraction(expectation, { meta: null, lines: [] });
    expect(result.metaAccuracy).toEqual({ docKind: false });
  });
});
