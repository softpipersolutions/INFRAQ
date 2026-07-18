import type { MasterSnapshot } from "@pebble/shared";
import { describe, expect, it } from "vitest";
import { buildMasterDigest, masterDigestHash } from "../src/index";

function snapshot(): MasterSnapshot {
  return {
    materials: [
      { materialCode: "FAS-SMK-001", materialName: "Smoke Detector", systemType: "FAS", category: "Detector", unitOfMeasure: "No.", active: true },
      { materialCode: "EXT-ABC-001", materialName: "ABC Extinguisher", systemType: "Extinguisher", category: "Extinguisher", unitOfMeasure: "No.", active: true },
    ],
    specs: [],
    makes: [
      { makeCode: "SMK-STD", materialCode: "FAS-SMK-001", brandName: "Agni Devices", tier: "Standard", approvalStatus: "Approved", notes: null },
      { makeCode: "EXT-STD", materialCode: "EXT-ABC-001", brandName: "Safepro", tier: "Standard", approvalStatus: "Approved", notes: null },
    ],
    prices: [
      { priceId: "P1", materialCode: "FAS-SMK-001", makeCode: "SMK-STD", buyingRatePaise: 105000, sellingRatePaise: 145000, effectiveFrom: "2024-01-01T00:00:00.000Z" },
      { priceId: "P2", materialCode: "EXT-ABC-001", makeCode: "EXT-STD", buyingRatePaise: 160000, sellingRatePaise: 210000, effectiveFrom: "2024-01-01T00:00:00.000Z" },
    ],
    installRates: [
      { rateCode: "INST-FAS-SMK-001", description: "x", systemType: "FAS", linkedMaterialCode: "FAS-SMK-001", ratePaise: 62350, unit: "Per No.", effectiveFrom: "2024-01-01T00:00:00.000Z" },
    ],
    rules: [
      { ruleId: "R1", ruleCode: "DL-FAS-001", ruleVersion: 1, systemType: "FAS", conditionExpr: "system = FAS", quantityFormula: "CEIL(total_area_sqm / 60)", outputMaterialCode: "FAS-SMK-001", standardReference: "IS 2189", active: true },
    ],
    marginMatrix: [
      { tier: 2, tierLabel: "₹5L–20L", targetMarginPct: 22, floorMarginPct: 15, discountAuthority: "GM" },
    ],
  };
}

describe("buildMasterDigest", () => {
  it("renders materials, makes, rules and margin tiers as text", () => {
    const text = buildMasterDigest(snapshot());
    expect(text).toContain("FAS-SMK-001");
    expect(text).toContain("Agni Devices");
    expect(text).toContain("DL-FAS-001");
    expect(text).toContain("IS 2189");
    expect(text).toContain("Tier 2");
    expect(text).toContain("₹ 1,450.00"); // formatted current price
  });
});

describe("masterDigestHash", () => {
  it("is stable regardless of array order (cache stays warm)", () => {
    const a = snapshot();
    const b = snapshot();
    b.materials.reverse();
    b.prices.reverse();
    b.makes.reverse();
    expect(masterDigestHash(a)).toBe(masterDigestHash(b));
  });

  it("changes when a rate changes (cache invalidates)", () => {
    const a = snapshot();
    const b = snapshot();
    b.prices[0]!.sellingRatePaise = 150000;
    expect(masterDigestHash(a)).not.toBe(masterDigestHash(b));
  });
});
