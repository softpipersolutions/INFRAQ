import { describe, expect, it } from "vitest";
import { normalizeLine } from "../src/ingest/normalize";
import type { RawLine } from "../src/ingest/types";

/** A minimal, fully-specified RawLine — tests override just what they need. */
function line(overrides: Partial<RawLine> = {}): RawLine {
  return {
    slNo: "A1",
    description: "SITC of Something",
    makeRaw: null,
    qty: 1,
    unitRaw: "Nos",
    unitRateRupees: 100,
    rateKind: "SITC",
    amountRupees: 100,
    section: null,
    page: 1,
    confidence: 0.8,
    ...overrides,
  };
}

describe("normalizeLine — units", () => {
  it.each([
    ["mtr", "Metre"],
    ["Mtr", "Metre"],
    ["MTR", "Metre"],
    ["pcs", "No."],
    ["Nos", "No."],
    ["nos.", "No."],
    ["set", "Set"],
    ["Sets", "Set"],
    ["kg", "Kg"],
    ["Kgs", "Kg"],
    ["ltr", "Litre"],
    ["lump sum", "Lot"],
    ["man-day", "Man-day"],
  ])("normalizes unit %s -> %s", (raw, expected) => {
    const n = normalizeLine(line({ unitRaw: raw }));
    expect(n.unit.normalized).toBe(expected);
  });

  it("normalizes a unit even with embedded whitespace/newlines (xlsx wrapped-text units)", () => {
    // tryNormalizeUnit collapses any run of whitespace (including "\n") via \s+,
    // so a wrapped Excel cell like "Lump\nSum" still resolves correctly.
    const n = normalizeLine(line({ unitRaw: "Lump\nSum" }));
    expect(n.unit.normalized).toBe("Lot");
  });

  it("returns null for an unrecognized unit, without throwing", () => {
    const n = normalizeLine(line({ unitRaw: "furlongs" }));
    expect(n.unit.normalized).toBeNull();
    expect(n.unit.raw).toBe("furlongs");
  });

  it("returns null unit when unitRaw is null", () => {
    const n = normalizeLine(line({ unitRaw: null }));
    expect(n.unit).toEqual({ raw: null, normalized: null });
  });
});

describe("normalizeLine — brands", () => {
  it("OR-splits alternatives and normalizes the first as primary", () => {
    const n = normalizeLine(line({ makeRaw: "Agni OR Ravel" }));
    expect(n.brand.alternatives).toEqual(["Agni", "Ravel"]);
    expect(n.brand.normalized).toBe("Agni Devices");
    expect(n.brand.raw).toBe("Agni OR Ravel");
  });

  it("splits on slash and comma alternatives too", () => {
    const n = normalizeLine(line({ makeRaw: "Kartar/Zoloto" }));
    expect(n.brand.alternatives).toEqual(["Kartar", "Zoloto"]);
    expect(n.brand.normalized).toBe("Kartar");
  });

  it("strips certification noise before resolving", () => {
    const n = normalizeLine(line({ makeRaw: "Honeywell (UL)" }));
    expect(n.brand.normalized).toBe("Honeywell");
  });

  it("returns null normalized for an unrecognized brand, never inventing one", () => {
    const n = normalizeLine(line({ makeRaw: "Acme Totally Made Up Co" }));
    expect(n.brand.normalized).toBeNull();
    expect(n.brand.alternatives).toEqual(["Acme Totally Made Up Co"]);
  });

  it("empty brand: raw null, no alternatives", () => {
    const n = normalizeLine(line({ makeRaw: null }));
    expect(n.brand).toEqual({ raw: null, normalized: null, alternatives: [] });
  });
});

describe("normalizeLine — money (paise conversion)", () => {
  it("converts rupees to integer paise", () => {
    const n = normalizeLine(line({ unitRateRupees: 2280.5, amountRupees: 314640 }));
    expect(n.sellPaise).toBe(228050);
    expect(n.amountPaise).toBe(31464000);
  });

  it("null rupee fields stay null paise fields, no warning", () => {
    const n = normalizeLine(line({ unitRateRupees: null, amountRupees: null }));
    expect(n.sellPaise).toBeNull();
    expect(n.amountPaise).toBeNull();
    expect(n.warnings).toEqual([]);
  });

  it("catches toPaise throwing on a non-finite value and records a warning", () => {
    const n = normalizeLine(line({ unitRateRupees: Number.POSITIVE_INFINITY }));
    expect(n.sellPaise).toBeNull();
    expect(n.warnings.some((w) => /unitRateRupees/.test(w))).toBe(true);
  });

  it("catches toPaise throwing on an unsafe-integer amount and records a warning", () => {
    const n = normalizeLine(line({ amountRupees: Number.MAX_SAFE_INTEGER }));
    expect(n.amountPaise).toBeNull();
    expect(n.warnings.some((w) => /amountRupees/.test(w))).toBe(true);
  });
});

describe("normalizeLine — cross-check", () => {
  it("ok when qty x rate ~= amount (within 1%), confidence bumped", () => {
    const n = normalizeLine(line({ qty: 10, unitRateRupees: 100, amountRupees: 1000, confidence: 0.9 }));
    expect(n.crossCheck).toBe("ok");
    expect(n.confidence).toBeCloseTo(0.95);
  });

  it("confidence bump is capped at 1", () => {
    const n = normalizeLine(line({ qty: 10, unitRateRupees: 100, amountRupees: 1000, confidence: 0.99 }));
    expect(n.crossCheck).toBe("ok");
    expect(n.confidence).toBe(1);
  });

  it("mismatch when qty x rate diverges from amount by more than 1%, confidence penalized", () => {
    const n = normalizeLine(line({ qty: 10, unitRateRupees: 100, amountRupees: 5000, confidence: 0.9 }));
    expect(n.crossCheck).toBe("mismatch");
    expect(n.confidence).toBeCloseTo(0.7);
  });

  it("confidence penalty floors at 0", () => {
    const n = normalizeLine(line({ qty: 10, unitRateRupees: 100, amountRupees: 5000, confidence: 0.1 }));
    expect(n.crossCheck).toBe("mismatch");
    expect(n.confidence).toBe(0);
  });

  it("n/a when qty, rate, or amount is absent — confidence untouched", () => {
    const n = normalizeLine(line({ qty: null, unitRateRupees: 100, amountRupees: 1000, confidence: 0.6 }));
    expect(n.crossCheck).toBe("n/a");
    expect(n.confidence).toBe(0.6);
  });
});

describe("normalizeLine — system/category keyword guesses", () => {
  it.each([
    ["Pendent Type Sprinkler activated @ 68 degrees", null, "Sprinkler"],
    ["SITC of RRL Hose Pipe for Hydrant Valve", null, "Hydrant"],
    ["SITC of Smoke Detectors with Base", null, "FAS"],
    ["Fire Extinguisher - ABC Type 6 Kgs", null, "Extinguisher"],
    ["Providing FM-200 clean agent suppression system", null, "Suppression"],
    ["Steel/Iron Angles/Channels/Plates etc.", null, null],
  ])("guesses system for %s", (description, section, expected) => {
    const n = normalizeLine(line({ description, section }));
    expect(n.systemGuess).toBe(expected);
  });

  it("checks the section text too, not just the description", () => {
    const n = normalizeLine(line({ description: "Steel angle support", section: "B. SPRINKLER RISER" }));
    expect(n.systemGuess).toBe("Sprinkler");
  });

  it.each([
    ["SITC of Smoke Detectors with Base", "Detector"],
    ["Fabrication of Electrical control panel", "Panel"],
    ["4 Core X 16 sqmm Armoured cable", "Cable"],
    ["SITC M.S. Pipe Class 'C' 150 mm", "Pipe"],
    ["SITC Butterfly Valve 150 mm", "Valve"],
    ["SITC of Diesel Fire Pump", "Pump"],
    ["Fire Extinguisher - CO2 Type", "Extinguisher"],
    ["Safety & Informative Signage for the facility", "Signage"],
  ])("guesses category for %s", (description, expected) => {
    const n = normalizeLine(line({ description }));
    expect(n.categoryGuess).toBe(expected);
  });

  it("returns null category when no keyword matches", () => {
    const n = normalizeLine(line({ description: "Civil Works" }));
    expect(n.categoryGuess).toBeNull();
  });
});


describe("scrubText via normalizeLine", () => {
  it("strips NUL and C0 control bytes Gemini emits for unmappable glyphs", () => {
    const n = normalizeLine({
      slNo: "1",
      description: "heat detector operating at 54\u0000C/57\u0000C fixed temp",
      makeRaw: "Agni\u0000",
      qty: 2,
      unitRaw: "Nos",
      unitRateRupees: 100,
      rateKind: "SITC",
      amountRupees: 200,
      section: "PART\u0001I",
      page: 1,
      confidence: 0.9,
    });
    expect(n.description).toBe("heat detector operating at 54 C/57 C fixed temp");
    expect(n.description).not.toContain("\u0000");
    expect(n.brand.raw).toBe("Agni");
    expect(n.section).toBe("PART I");
  });
});
