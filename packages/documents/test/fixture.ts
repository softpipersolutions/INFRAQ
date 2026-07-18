import type { EstimateTotals, PricedLine, SystemType, UnitOfMeasure } from "@pebble/shared";
import { applyPct, lineAmount, sumPaise } from "@pebble/shared";
import { buildFormatAInput } from "../src/index";
import type { FormatAInput } from "../src/index";

/**
 * A realistic Commercial-mall estimate: 5 Fire-Alarm lines + 2 Extinguisher
 * lines across two PART sections. Line money is computed with the shared money
 * helpers (integer paise, single rounding point) exactly the way the pricing
 * engine would, and the `EstimateTotals` are aggregated from those lines — so
 * the fixture's grand total is a real, self-consistent figure the tests assert
 * against.
 */

interface LineSpec {
  systemType: SystemType;
  sectionOrder: number;
  lineOrder: number;
  materialCode: string;
  description: string;
  brandName: string;
  qty: number;
  unit: UnitOfMeasure;
  supplyRatePaise: number;
  installRatePaise: number;
  note?: string | null;
}

function makeLine(spec: LineSpec): PricedLine {
  const sitcRatePaise = spec.supplyRatePaise + spec.installRatePaise;
  const supplyAmountPaise = lineAmount(spec.qty, spec.supplyRatePaise);
  const installAmountPaise = lineAmount(spec.qty, spec.installRatePaise);
  return {
    lineUid: `uid-${spec.materialCode}`,
    systemType: spec.systemType,
    sectionOrder: spec.sectionOrder,
    lineOrder: spec.lineOrder,
    materialCode: spec.materialCode,
    description: spec.description,
    makeCode: `${spec.materialCode}-MK`,
    brandName: spec.brandName,
    qty: spec.qty,
    unit: spec.unit,
    supplyRatePaise: spec.supplyRatePaise,
    installRatePaise: spec.installRatePaise,
    sitcRatePaise,
    supplyAmountPaise,
    installAmountPaise,
    lineAmountPaise: supplyAmountPaise + installAmountPaise,
    source: "RULE",
    ruleCode: `R-${spec.materialCode}`,
    priceId: `P-${spec.materialCode}`,
    installRateCode: `INST-${spec.materialCode}`,
    installRateUnit: "Per No.",
    note: spec.note ?? null,
    editReason: null,
  };
}

const SPECS: LineSpec[] = [
  // PART I — Fire Alarm System
  {
    systemType: "FAS",
    sectionOrder: 0,
    lineOrder: 0,
    materialCode: "FAS-PANEL-4Z",
    description: "Addressable Fire Alarm Panel, 4 loop, with battery backup",
    brandName: "Honeywell",
    qty: 1,
    unit: "No.",
    supplyRatePaise: 4_500_000,
    installRatePaise: 1_935_000,
    note: "IS 2189 compliant",
  },
  {
    systemType: "FAS",
    sectionOrder: 0,
    lineOrder: 1,
    materialCode: "FAS-SMK-001",
    description: "Photoelectric Smoke Detector",
    brandName: "Agni Devices",
    qty: 48,
    unit: "No.",
    supplyRatePaise: 145_000,
    installRatePaise: 62_350,
  },
  {
    systemType: "FAS",
    sectionOrder: 0,
    lineOrder: 2,
    materialCode: "FAS-MCP-001",
    description: "Manual Call Point, break-glass type",
    brandName: "Edwards",
    qty: 12,
    unit: "No.",
    supplyRatePaise: 95_000,
    installRatePaise: 40_850,
  },
  {
    systemType: "FAS",
    sectionOrder: 0,
    lineOrder: 3,
    materialCode: "FAS-HOOT-001",
    description: "Electronic Hooter cum Strobe, 24V DC",
    brandName: "Notifier",
    qty: 12,
    unit: "No.",
    supplyRatePaise: 78_000,
    installRatePaise: 33_540,
  },
  {
    systemType: "FAS",
    sectionOrder: 0,
    lineOrder: 4,
    materialCode: "FAS-CABLE-001",
    description: "FRLS Armoured Cable, 2C x 1.5 sqmm",
    brandName: "Polycab",
    qty: 1200,
    unit: "Metre",
    supplyRatePaise: 8_500,
    installRatePaise: 3_655,
  },
  // PART II — Portable Fire Extinguishers
  {
    systemType: "Extinguisher",
    sectionOrder: 1,
    lineOrder: 0,
    materialCode: "EXT-ABC-004",
    description: "ABC Dry Powder Extinguisher, 4kg, ISI marked",
    brandName: "Safepro",
    qty: 40,
    unit: "No.",
    supplyRatePaise: 210_000,
    installRatePaise: 90_300,
  },
  {
    systemType: "Extinguisher",
    sectionOrder: 1,
    lineOrder: 1,
    materialCode: "EXT-CO2-045",
    description: "CO2 Extinguisher, 4.5kg",
    brandName: "Safepro",
    qty: 8,
    unit: "No.",
    supplyRatePaise: 380_000,
    installRatePaise: 120_000,
  },
];

/** The priced lines of the mall estimate. */
export function fixtureLines(): PricedLine[] {
  return SPECS.map(makeLine);
}

/** `EstimateTotals` aggregated from the fixture lines (GST @ 18%). */
export function fixtureTotals(lines: PricedLine[] = fixtureLines()): EstimateTotals {
  const totalSupplyPaise = sumPaise(lines.map((l) => l.supplyAmountPaise));
  const totalInstallPaise = sumPaise(lines.map((l) => l.installAmountPaise));
  const totalSitcPaise = sumPaise(lines.map((l) => l.lineAmountPaise));
  const gstPaise = applyPct(totalSitcPaise, 18);
  const grandTotalPaise = totalSitcPaise + gstPaise;
  const blendedRatio = totalSupplyPaise === 0 ? null : totalSitcPaise / totalSupplyPaise;
  return {
    totalSupplyPaise,
    totalInstallPaise,
    totalSitcPaise,
    gstPaise,
    grandTotalPaise,
    blendedRatio,
  };
}

/** Full `FormatAInput` for the mall estimate, ready for both renderers. */
export function fixtureInput(overrides: { attention?: string } = {}): FormatAInput {
  const lines = fixtureLines();
  const totals = fixtureTotals(lines);
  return buildFormatAInput({
    estimateId: "GBE-EST-2025-014",
    revision: "R1",
    dateISO: "2026-07-18",
    validityDays: 7,
    project: {
      clientName: "Phoenix Mills Ltd",
      projectName: "Phoenix Marketplace Mall, Gomti Nagar",
      clientEmail: "projects@phoenixmills.example",
      clientPhone: "+91 90000 11111",
      buildingType: "Commercial",
      applicableStandard: "IS",
      attention: overrides.attention ?? "Mr. R. Menon, Projects Head",
    },
    lines,
    totals,
    blendedRatio: totals.blendedRatio,
    sitcStatus: "PASS",
  });
}
