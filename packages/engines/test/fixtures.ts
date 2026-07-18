import type { MasterSnapshot } from "@pebble/shared";
import type { GenerationInput } from "../src/index";

/**
 * A compact, hand-verifiable MasterSnapshot mirroring the seed's structure and
 * its 43%-install invariant. Three materials (2 FAS + 1 Extinguisher), makes
 * across all three tiers for the smoke detector, and material-linked install
 * rates at exactly 43% of each Standard selling rate.
 */
export function fixtureSnapshot(): MasterSnapshot {
  return {
    materials: [
      { materialCode: "FAS-SMK-001", materialName: "Smoke Detector", systemType: "FAS", category: "Detector", unitOfMeasure: "No.", active: true },
      { materialCode: "FAS-CABLE-001", materialName: "FRLS Cable", systemType: "FAS", category: "Cable", unitOfMeasure: "Metre", active: true },
      { materialCode: "EXT-ABC-001", materialName: "ABC Extinguisher 4kg", systemType: "Extinguisher", category: "Extinguisher", unitOfMeasure: "No.", active: true },
      { materialCode: "FAS-OLD-001", materialName: "Discontinued Detector", systemType: "FAS", category: "Detector", unitOfMeasure: "No.", active: false },
    ],
    specs: [],
    makes: [
      { makeCode: "SMK-STD", materialCode: "FAS-SMK-001", brandName: "Agni Devices", tier: "Standard", approvalStatus: "Approved", notes: null },
      { makeCode: "SMK-PREM", materialCode: "FAS-SMK-001", brandName: "Honeywell", tier: "Premium", approvalStatus: "Approved", notes: null },
      { makeCode: "SMK-ECON", materialCode: "FAS-SMK-001", brandName: "Ravel", tier: "Economy", approvalStatus: "Approved", notes: null },
      { makeCode: "CABLE-STD", materialCode: "FAS-CABLE-001", brandName: "Polycab", tier: "Standard", approvalStatus: "Approved", notes: null },
      { makeCode: "EXT-STD", materialCode: "EXT-ABC-001", brandName: "Safepro", tier: "Standard", approvalStatus: "Approved", notes: null },
      { makeCode: "OLD-STD", materialCode: "FAS-OLD-001", brandName: "Legacy", tier: "Standard", approvalStatus: "Approved", notes: null },
    ],
    prices: [
      { priceId: "P-SMK-STD", materialCode: "FAS-SMK-001", makeCode: "SMK-STD", buyingRatePaise: 105000, sellingRatePaise: 145000, effectiveFrom: "2024-01-01T00:00:00.000Z" },
      { priceId: "P-SMK-PREM", materialCode: "FAS-SMK-001", makeCode: "SMK-PREM", buyingRatePaise: 205000, sellingRatePaise: 265000, effectiveFrom: "2024-01-01T00:00:00.000Z" },
      { priceId: "P-SMK-ECON", materialCode: "FAS-SMK-001", makeCode: "SMK-ECON", buyingRatePaise: 90000, sellingRatePaise: 115000, effectiveFrom: "2024-01-01T00:00:00.000Z" },
      { priceId: "P-CABLE-STD", materialCode: "FAS-CABLE-001", makeCode: "CABLE-STD", buyingRatePaise: 6200, sellingRatePaise: 8500, effectiveFrom: "2024-01-01T00:00:00.000Z" },
      { priceId: "P-EXT-STD", materialCode: "EXT-ABC-001", makeCode: "EXT-STD", buyingRatePaise: 160000, sellingRatePaise: 210000, effectiveFrom: "2024-01-01T00:00:00.000Z" },
      { priceId: "P-OLD-STD", materialCode: "FAS-OLD-001", makeCode: "OLD-STD", buyingRatePaise: 90000, sellingRatePaise: 120000, effectiveFrom: "2024-01-01T00:00:00.000Z" },
    ],
    installRates: [
      { rateCode: "INST-FAS-SMK-001", description: "ITC smoke", systemType: "FAS", linkedMaterialCode: "FAS-SMK-001", ratePaise: 62350, unit: "Per No.", effectiveFrom: "2024-01-01T00:00:00.000Z" },
      { rateCode: "INST-FAS-CABLE-001", description: "ITC cable", systemType: "FAS", linkedMaterialCode: "FAS-CABLE-001", ratePaise: 3655, unit: "Per Metre", effectiveFrom: "2024-01-01T00:00:00.000Z" },
      { rateCode: "INST-EXT-ABC-001", description: "ITC extinguisher", systemType: "Extinguisher", linkedMaterialCode: "EXT-ABC-001", ratePaise: 90300, unit: "Per No.", effectiveFrom: "2024-01-01T00:00:00.000Z" },
    ],
    rules: [
      { ruleId: "R-SMK", ruleCode: "DL-FAS-001", ruleVersion: 1, systemType: "FAS", conditionExpr: "system = FAS", quantityFormula: "CEIL(total_area_sqm / 60)", outputMaterialCode: "FAS-SMK-001", standardReference: "IS 2189", active: true },
      { ruleId: "R-CABLE", ruleCode: "DL-FAS-007", ruleVersion: 1, systemType: "FAS", conditionExpr: "system = FAS", quantityFormula: "ROUND(total_area_sqm * 1.5)", outputMaterialCode: "FAS-CABLE-001", standardReference: "IS 1554", active: true },
      { ruleId: "R-EXT", ruleCode: "DL-EXT-001", ruleVersion: 1, systemType: "Extinguisher", conditionExpr: "system = Extinguisher", quantityFormula: "CEIL(total_area_sqm / 200)", outputMaterialCode: "EXT-ABC-001", standardReference: "IS 2190", active: true },
    ],
    marginMatrix: [
      { tier: 1, tierLabel: "Sub ₹5L", targetMarginPct: 25, floorMarginPct: 18, discountAuthority: "Self" },
      { tier: 2, tierLabel: "₹5L–20L", targetMarginPct: 22, floorMarginPct: 15, discountAuthority: "GM" },
      { tier: 3, tierLabel: "₹20L–1Cr", targetMarginPct: 20, floorMarginPct: 12, discountAuthority: "GM" },
      { tier: 4, tierLabel: ">₹1Cr", targetMarginPct: 18, floorMarginPct: 10, discountAuthority: "MD" },
    ],
  };
}

/** The canonical demo enquiry (Commercial, 4 floors, 450 sqm, FAS + Extinguisher, tier 2). */
export const DEMO_INPUT: GenerationInput = {
  buildingType: "Commercial",
  floorsAbove: 4,
  floorAreaSqm: 450,
  systemsRequired: ["FAS", "Extinguisher"],
  makePreference: "As per Greenberg",
  applicableStandard: "IS",
  projectTier: 2,
};

/** Deterministic incrementing line-uid factory for golden tests. */
export function counterUid(): () => string {
  let i = 0;
  return () => `L${String(i++).padStart(2, "0")}`;
}
