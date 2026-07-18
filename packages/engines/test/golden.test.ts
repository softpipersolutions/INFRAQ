import { describe, expect, it } from "vitest";
import { generateBom, generateEstimate } from "../src/index";
import { DEMO_INPUT, counterUid, fixtureSnapshot } from "./fixtures";

/**
 * Golden test — frozen, hand-verified outputs for the canonical demo enquiry.
 * A change to the deterministic engines that alters any figure here breaks CI
 * with a readable diff (this is the backbone regression guard).
 */
describe("generateEstimate — golden demo", () => {
  const gen = generateEstimate(DEMO_INPUT, fixtureSnapshot(), { uid: counterUid() });

  it("produces the expected lines with zero warnings", () => {
    expect(gen.warnings).toEqual([]);
    expect(gen.lines.map((l) => [l.lineUid, l.materialCode, l.qty, l.lineAmountPaise])).toEqual([
      // FAS section — rules processed in rule_code order
      ["L00", "FAS-SMK-001", 30, 6_220_500], // 30 × (145000 + 62350)
      ["L01", "FAS-CABLE-001", 2700, 32_818_500], // 2700 × (8500 + 3655)
      // Extinguisher section
      ["L02", "EXT-ABC-001", 9, 2_702_700], // 9 × (210000 + 90300)
    ]);
  });

  it("assigns section and line order per system", () => {
    const smoke = gen.lines.find((l) => l.materialCode === "FAS-SMK-001");
    const ext = gen.lines.find((l) => l.materialCode === "EXT-ABC-001");
    expect([smoke?.sectionOrder, smoke?.lineOrder]).toEqual([0, 0]);
    expect([ext?.sectionOrder, ext?.lineOrder]).toEqual([1, 0]);
  });

  it("selects the Standard make for 'As per Greenberg'", () => {
    const smoke = gen.lines.find((l) => l.materialCode === "FAS-SMK-001");
    expect(smoke?.makeCode).toBe("SMK-STD");
    expect(smoke?.brandName).toBe("Agni Devices");
    expect(smoke?.supplyRatePaise).toBe(145000);
    expect(smoke?.installRatePaise).toBe(62350);
    expect(smoke?.sitcRatePaise).toBe(207350);
  });

  it("computes SITC exactly at the 1.43 target → PASS", () => {
    expect(gen.sitc.totalSupplyPaise).toBe(29_190_000);
    expect(gen.sitc.totalInstallPaise).toBe(12_551_700);
    expect(gen.sitc.totalSitcPaise).toBe(41_741_700);
    expect(gen.sitc.blendedRatio).toBe(1.43);
    expect(gen.sitc.status).toBe("PASS");
  });

  it("passes the tier-2 margin gate", () => {
    // sell 29,190,000 · buy (30×105000 + 2700×6200 + 9×160000) = 21,330,000
    expect(gen.margin.marginPct).toBe(26.93);
    expect(gen.margin.status).toBe("OK");
    expect(gen.margin.requiredAuthority).toBeNull();
  });

  it("rolls up 18% GST into the grand total", () => {
    expect(gen.totals.gstPaise).toBe(7_513_506); // round(41,741,700 × 0.18)
    expect(gen.totals.grandTotalPaise).toBe(49_255_206);
  });

  it("pins a replayable snapshot", () => {
    expect(gen.snapshot.ruleIds).toEqual(["R-SMK", "R-CABLE", "R-EXT"]);
    expect(gen.snapshot.priceIds).toEqual(["P-SMK-STD", "P-CABLE-STD", "P-EXT-STD"]);
    expect(gen.snapshot.installRateCodes).toEqual([
      "INST-FAS-SMK-001",
      "INST-FAS-CABLE-001",
      "INST-EXT-ABC-001",
    ]);
    expect(gen.snapshot.marginTier).toBe(2);
    expect(gen.snapshot.engineVersion).toBe("b-1.0.0");
  });

  it("is byte-for-byte reproducible for identical inputs", () => {
    const again = generateEstimate(DEMO_INPUT, fixtureSnapshot(), { uid: counterUid() });
    expect(again).toEqual(gen);
  });
});

describe("generateBom — warning behaviour", () => {
  it("warns NO_RULES_MATCHED for a requested system with no firing rule", () => {
    const bom = generateBom(
      { ...DEMO_INPUT, systemsRequired: ["Sprinkler"] },
      fixtureSnapshot(),
    );
    expect(bom.lines).toHaveLength(0);
    expect(bom.warnings.map((w) => w.kind)).toContain("NO_RULES_MATCHED");
  });

  it("warns MATERIAL_INACTIVE and skips a rule pointing at an inactive material", () => {
    const snap = fixtureSnapshot();
    snap.rules.push({
      ruleId: "R-OLD",
      ruleCode: "DL-FAS-099",
      ruleVersion: 1,
      systemType: "FAS",
      conditionExpr: "system = FAS",
      quantityFormula: "1",
      outputMaterialCode: "FAS-OLD-001",
      standardReference: null,
      active: true,
    });
    const bom = generateBom({ ...DEMO_INPUT, systemsRequired: ["FAS"] }, snap);
    expect(bom.warnings.map((w) => w.kind)).toContain("MATERIAL_INACTIVE");
    expect(bom.lines.some((l) => l.materialCode === "FAS-OLD-001")).toBe(false);
  });

  it("warns RULE_EVAL_ERROR when a formula cannot evaluate (division by zero)", () => {
    const snap = fixtureSnapshot();
    snap.rules.push({
      ruleId: "R-BAD",
      ruleCode: "DL-FAS-098",
      ruleVersion: 1,
      systemType: "FAS",
      conditionExpr: "system = FAS",
      quantityFormula: "floor_area_sqm / 0",
      outputMaterialCode: "FAS-SMK-001",
      standardReference: null,
      active: true,
    });
    const bom = generateBom({ ...DEMO_INPUT, systemsRequired: ["FAS"] }, snap);
    expect(bom.warnings.map((w) => w.kind)).toContain("RULE_EVAL_ERROR");
  });
});
