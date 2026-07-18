import type { BomLine, MakePreference, MasterSnapshot } from "@pebble/shared";
import { describe, expect, it } from "vitest";
import { priceBom } from "../src/index";

/**
 * Pricing matrix (B.02) — make selection under every preference/availability
 * combination, and install-rate resolution (material-linked → generic →
 * missing, plus the Lumpsum flat-charge path).
 */

const bomLine: BomLine = {
  systemType: "FAS",
  materialCode: "MAT-1",
  materialName: "Material One",
  unit: "No.",
  qty: 10,
  ruleCode: "R-1",
  ruleId: "r-1",
  standardReference: null,
};

type MakeSpec = { code: string; tier: "Premium" | "Standard" | "Economy"; approval: "Approved" | "Conditional" | "Blacklisted"; sell: number; buy: number };

function snap(makes: MakeSpec[], opts: { install?: MasterSnapshot["installRates"] } = {}): MasterSnapshot {
  return {
    materials: [
      { materialCode: "MAT-1", materialName: "Material One", systemType: "FAS", category: "Detector", unitOfMeasure: "No.", active: true },
    ],
    specs: [],
    makes: makes.map((m) => ({ makeCode: m.code, materialCode: "MAT-1", brandName: m.code, tier: m.tier, approvalStatus: m.approval, notes: null })),
    prices: makes.map((m) => ({ priceId: `P-${m.code}`, materialCode: "MAT-1", makeCode: m.code, buyingRatePaise: m.buy, sellingRatePaise: m.sell, effectiveFrom: "2024-01-01T00:00:00.000Z" })),
    installRates:
      opts.install ??
      [{ rateCode: "INST-MAT-1", description: "x", systemType: "FAS", linkedMaterialCode: "MAT-1", ratePaise: 43000, unit: "Per No.", effectiveFrom: "2024-01-01T00:00:00.000Z" }],
    rules: [],
    marginMatrix: [],
  };
}

function price(pref: MakePreference, s: MasterSnapshot) {
  return priceBom([bomLine], { makePreference: pref }, s, { uid: () => "L0" });
}

describe("make selection", () => {
  const allTiers: MakeSpec[] = [
    { code: "STD", tier: "Standard", approval: "Approved", sell: 100000, buy: 78000 },
    { code: "PREM", tier: "Premium", approval: "Approved", sell: 180000, buy: 140000 },
    { code: "ECON", tier: "Economy", approval: "Approved", sell: 80000, buy: 62000 },
  ];

  it("'As per Greenberg' picks the Approved Standard make", () => {
    const r = price("As per Greenberg", snap(allTiers));
    expect(r.lines[0]?.makeCode).toBe("STD");
    expect(r.warnings).toEqual([]);
  });

  it("explicit tier preferences are honoured", () => {
    expect(price("Premium", snap(allTiers)).lines[0]?.makeCode).toBe("PREM");
    expect(price("Economy", snap(allTiers)).lines[0]?.makeCode).toBe("ECON");
  });

  it("falls back Standard→Premium→Economy with a MAKE_UNAVAILABLE warning", () => {
    // No Premium make; prefer Premium → should fall back to Standard.
    const r = price("Premium", snap([
      { code: "STD", tier: "Standard", approval: "Approved", sell: 100000, buy: 78000 },
      { code: "ECON", tier: "Economy", approval: "Approved", sell: 80000, buy: 62000 },
    ]));
    expect(r.lines[0]?.makeCode).toBe("STD");
    expect(r.warnings.map((w) => w.kind)).toContain("MAKE_UNAVAILABLE");
  });

  it("uses a Conditional make only when no Approved make exists", () => {
    const r = price("Standard", snap([
      { code: "STD-C", tier: "Standard", approval: "Conditional", sell: 100000, buy: 78000 },
    ]));
    expect(r.lines[0]?.makeCode).toBe("STD-C");
    expect(r.warnings.map((w) => w.kind)).toContain("MAKE_UNAVAILABLE");
  });

  it("prefers an Approved make over a Conditional one of the preferred tier", () => {
    const r = price("Standard", snap([
      { code: "STD-C", tier: "Standard", approval: "Conditional", sell: 90000, buy: 70000 },
      { code: "STD-A", tier: "Standard", approval: "Approved", sell: 100000, buy: 78000 },
    ]));
    expect(r.lines[0]?.makeCode).toBe("STD-A");
    expect(r.warnings).toEqual([]);
  });

  it("skips the line with MAKE_UNAVAILABLE when nothing is usable", () => {
    const r = price("Standard", snap([
      { code: "BL", tier: "Standard", approval: "Blacklisted", sell: 100000, buy: 78000 },
    ]));
    expect(r.lines).toHaveLength(0);
    expect(r.warnings.map((w) => w.kind)).toContain("MAKE_UNAVAILABLE");
  });

  it("skips the line with PRICE_MISSING when the selected make has no price", () => {
    const s = snap([{ code: "STD", tier: "Standard", approval: "Approved", sell: 100000, buy: 78000 }]);
    s.prices = []; // remove the price
    const r = price("Standard", s);
    expect(r.lines).toHaveLength(0);
    expect(r.warnings.map((w) => w.kind)).toContain("PRICE_MISSING");
  });
});

describe("install-rate resolution", () => {
  const oneStd: MakeSpec[] = [{ code: "STD", tier: "Standard", approval: "Approved", sell: 100000, buy: 78000 }];

  it("uses the material-linked rate and scales it by qty", () => {
    const r = price("Standard", snap(oneStd));
    const line = r.lines[0]!;
    expect(line.installRateCode).toBe("INST-MAT-1");
    expect(line.installAmountPaise).toBe(10 * 43000);
    expect(line.lineAmountPaise).toBe(10 * 100000 + 10 * 43000);
  });

  it("falls back to a unit-compatible system-generic rate", () => {
    const r = price(
      "Standard",
      snap(oneStd, {
        install: [
          { rateCode: "INST-FAS-GEN", description: "generic", systemType: "FAS", linkedMaterialCode: null, ratePaise: 30000, unit: "Per No.", effectiveFrom: "2024-01-01T00:00:00.000Z" },
        ],
      }),
    );
    expect(r.lines[0]?.installRateCode).toBe("INST-FAS-GEN");
    expect(r.lines[0]?.installAmountPaise).toBe(10 * 30000);
  });

  it("applies a Lumpsum install rate as a flat charge (qty ignored)", () => {
    const r = price(
      "Standard",
      snap(oneStd, {
        install: [
          { rateCode: "INST-LUMP", description: "lump", systemType: "FAS", linkedMaterialCode: "MAT-1", ratePaise: 500000, unit: "Lumpsum", effectiveFrom: "2024-01-01T00:00:00.000Z" },
        ],
      }),
    );
    expect(r.lines[0]?.installAmountPaise).toBe(500000);
  });

  it("warns INSTALL_RATE_MISSING and prices supply-only when nothing resolves", () => {
    const r = price("Standard", snap(oneStd, { install: [] }));
    expect(r.warnings.map((w) => w.kind)).toContain("INSTALL_RATE_MISSING");
    expect(r.lines[0]?.installAmountPaise).toBe(0);
    expect(r.lines[0]?.lineAmountPaise).toBe(10 * 100000);
  });
});
