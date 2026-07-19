import { describe, expect, it } from "vitest";
import {
  normalizeBrandOrRaw,
  splitBrandAlternatives,
  stripMarkTokens,
  tryNormalizeBrand,
} from "../src/brands";

/**
 * Brand canonicalisation folds every corpus make variant — wrapped in
 * certification marks, vendor labels and OR-alternatives — to one canonical
 * name, and NEVER invents a name it has not observed (unknown → null).
 */

describe("brand normalization (alias lookup)", () => {
  const cases: Array<[string, string]> = [
    ["Agni", "Agni Devices"],
    ["AGNI DEVICES", "Agni Devices"],
    ["Honeywell (UL)", "Honeywell"],
    ["Jindal (ISI)", "Jindal"],
    ["ISI Marked Jindal", "Jindal"],
    ["M/s Kirloskar", "Kirloskar"],
    ["Kirloskar Brothers", "Kirloskar"],
    ["new age", "Newage"],
    ["HD Fire Protect", "HD Fire"],
    ["Make - Polycab", "Polycab"],
    ["Brand: Exide", "Exide"],
    ["  zoloto  ", "Zoloto"],
    ["Tyco FM Approved", "Tyco"],
  ];
  it.each(cases)("%s → %s", (raw, expected) => {
    expect(tryNormalizeBrand(raw)).toBe(expected);
  });

  it("returns null for an unobserved brand (never invents)", () => {
    expect(tryNormalizeBrand("Bosch")).toBeNull();
    expect(tryNormalizeBrand("Some Random Vendor Pvt Ltd")).toBeNull();
  });
});

describe("stripMarkTokens", () => {
  const cases: Array<[string, string]> = [
    ["Jindal ISI Marked", "Jindal"],
    ["Jindal (ISI)", "Jindal"],
    ["Honeywell (UL)", "Honeywell"],
    ["Notifier UL Listed", "Notifier"],
    ["Tyco FM Approved", "Tyco"],
    ["Zoloto (FM)", "Zoloto"],
    ["Kartar CE", "Kartar"],
    ["Siemens IS Marked", "Siemens"],
    ["Make - Polycab", "Polycab"],
    ["Make: Ravel", "Ravel"],
    ["Brand: Exide", "Exide"],
    ["  Simplex   ", "Simplex"],
  ];
  it.each(cases)("%s → %s", (raw, expected) => {
    expect(stripMarkTokens(raw)).toBe(expected);
  });

  it("does not chew through an embedded 'ce' inside a word", () => {
    expect(stripMarkTokens("Ceasefire")).toBe("Ceasefire");
  });
});

describe("splitBrandAlternatives", () => {
  it("splits on case-insensitive OR", () => {
    expect(splitBrandAlternatives("Agni OR Ravel")).toEqual(["Agni", "Ravel"]);
    expect(splitBrandAlternatives("Agni or Ravel or Honeywell")).toEqual([
      "Agni",
      "Ravel",
      "Honeywell",
    ]);
  });

  it("splits on slash and comma", () => {
    expect(splitBrandAlternatives("Honeywell / Notifier")).toEqual(["Honeywell", "Notifier"]);
    expect(splitBrandAlternatives("Jindal, Tata")).toEqual(["Jindal", "Tata"]);
    expect(splitBrandAlternatives("Agni/Ravel")).toEqual(["Agni", "Ravel"]);
  });

  it("mixes separators and drops empties", () => {
    expect(splitBrandAlternatives("Agni OR Ravel / Honeywell")).toEqual([
      "Agni",
      "Ravel",
      "Honeywell",
    ]);
    expect(splitBrandAlternatives("Polycab")).toEqual(["Polycab"]);
    expect(splitBrandAlternatives("  ,  / ")).toEqual([]);
  });
});

describe("normalizeBrandOrRaw", () => {
  it("keeps the raw and adds the canonical (or null)", () => {
    expect(normalizeBrandOrRaw("Agni")).toEqual({ raw: "Agni", normalized: "Agni Devices" });
    expect(normalizeBrandOrRaw("Bosch")).toEqual({ raw: "Bosch", normalized: null });
  });
});
