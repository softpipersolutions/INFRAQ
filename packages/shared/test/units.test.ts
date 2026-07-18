import { describe, expect, it } from "vitest";
import { formatSequentialId } from "../src/constants";
import { UnitNormalizationError, normalizeUnit, tryNormalizeUnit } from "../src/units";

/**
 * Unit canonicalisation must fold every corpus variant to one canonical unit;
 * ingestion must never write a non-canonical unit. Business-id formatting is
 * pinned here too (GBE-ENQ-YYYY-NNN).
 */

describe("unit normalization", () => {
  const cases: Array<[string, string]> = [
    ["no", "No."],
    ["nos", "No."],
    ["pcs", "No."],
    ["each", "No."],
    ["points", "No."],
    ["mtr", "Metre"],
    ["Running Metre", "Metre"],
    ["RMT", "Metre"],
    ["set", "Set"],
    ["pair", "Set"],
    ["kg", "Kg"],
    ["ltr", "Litre"],
    ["lumpsum", "Lot"],
    ["L.S.", "Lot"],
    ["job", "Lot"],
    ["md", "Man-day"],
    ["man days", "Man-day"],
  ];
  it.each(cases)("%s → %s", (raw, expected) => {
    expect(normalizeUnit(raw)).toBe(expected);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeUnit("  NOS  ")).toBe("No.");
    expect(normalizeUnit("Mtr.")).toBe("Metre");
  });

  it("returns null / throws for an unknown unit", () => {
    expect(tryNormalizeUnit("furlong")).toBeNull();
    expect(() => normalizeUnit("furlong")).toThrow(UnitNormalizationError);
  });
});

describe("formatSequentialId", () => {
  it("zero-pads the sequence to three digits", () => {
    expect(formatSequentialId("GBE-ENQ", 2026, 1)).toBe("GBE-ENQ-2026-001");
    expect(formatSequentialId("GBE-EST", 2025, 14)).toBe("GBE-EST-2025-014");
    expect(formatSequentialId("GBE-ENQ", 2026, 137)).toBe("GBE-ENQ-2026-137");
  });
});
