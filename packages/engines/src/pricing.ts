import type {
  BomLine,
  GenerationWarning,
  InstallRate,
  InstallRateUnit,
  Make,
  MakePreference,
  MakeTier,
  MasterSnapshot,
  Price,
  PricedLine,
  UnitOfMeasure,
} from "@pebble/shared";
import { lineAmount } from "@pebble/shared";

/**
 * B.02 — Pricing. Selects a make (Approved makes of the preferred tier, then a
 * Standard→Premium→Economy fallback, Conditional only when no Approved exists),
 * resolves the current selling rate and install rate, and computes the line
 * money. Additivity is the load-bearing invariant tested by the property suite:
 *   lineAmount = supplyAmount + installAmount
 * All arithmetic is integer paise with a single rounding point (lineAmount).
 */

/** A priced line plus the buying cost the margin gate needs (never persisted). */
export interface PricedLineWithCost extends PricedLine {
  buyingRatePaise: number;
}

export interface PriceBomResult {
  lines: PricedLineWithCost[];
  warnings: GenerationWarning[];
  priceIds: string[];
  installRateCodes: string[];
}

const TIER_FALLBACK_ORDER: MakeTier[] = ["Standard", "Premium", "Economy"];

/** make_preference → the make tier to try first ("As per Greenberg" → Standard). */
function preferredTier(pref: MakePreference): MakeTier {
  return pref === "As per Greenberg" ? "Standard" : pref;
}

function tierSearchOrder(preferred: MakeTier): MakeTier[] {
  return [preferred, ...TIER_FALLBACK_ORDER.filter((t) => t !== preferred)];
}

function byMakeCode(a: Make, b: Make): number {
  return a.makeCode < b.makeCode ? -1 : a.makeCode > b.makeCode ? 1 : 0;
}

interface MakeSelection {
  make: Make;
  usedFallbackTier: boolean;
  usedConditional: boolean;
}

/** Deterministic make selection per spec B.02. */
function selectMake(makes: Make[], preferred: MakeTier): MakeSelection | null {
  const order = tierSearchOrder(preferred);
  for (const approvalStatus of ["Approved", "Conditional"] as const) {
    const pool = makes.filter((m) => m.approvalStatus === approvalStatus).sort(byMakeCode);
    for (const tier of order) {
      const candidate = pool.find((m) => m.tier === tier);
      if (candidate) {
        return {
          make: candidate,
          usedFallbackTier: tier !== preferred,
          usedConditional: approvalStatus === "Conditional",
        };
      }
    }
  }
  return null;
}

/** Install unit → the material unit it prices per (Lumpsum is a flat charge). */
const INSTALL_UNIT_TO_MATERIAL_UNIT: Record<InstallRateUnit, UnitOfMeasure | null> = {
  "Per No.": "No.",
  "Per Metre": "Metre",
  "Per Set": "Set",
  "Per Floor": null,
  Lumpsum: null,
};

function unitCompatible(installUnit: InstallRateUnit, materialUnit: UnitOfMeasure): boolean {
  if (installUnit === "Lumpsum") return true; // flat charge applies to any line
  return INSTALL_UNIT_TO_MATERIAL_UNIT[installUnit] === materialUnit;
}

/** Resolve the install rate: material-linked first, then a unit-compatible generic. */
function resolveInstallRate(
  snapshot: MasterSnapshot,
  line: BomLine,
): InstallRate | null {
  const linked = snapshot.installRates
    .filter((r) => r.linkedMaterialCode === line.materialCode)
    .sort((a, b) => (a.rateCode < b.rateCode ? -1 : 1));
  if (linked[0]) return linked[0];

  const generic = snapshot.installRates
    .filter(
      (r) =>
        r.linkedMaterialCode === null &&
        r.systemType === line.systemType &&
        unitCompatible(r.unit, line.unit),
    )
    .sort((a, b) => (a.rateCode < b.rateCode ? -1 : 1));
  return generic[0] ?? null;
}

/** Install amount: per-unit rates scale by qty; Lumpsum/Per Floor are flat. */
function installAmountPaise(rate: InstallRate, qty: number): number {
  if (rate.unit === "Lumpsum" || rate.unit === "Per Floor") return rate.ratePaise;
  return lineAmount(qty, rate.ratePaise);
}

export interface PriceBomOptions {
  /** Injectable line-uid factory (deterministic golden tests pass a counter). */
  uid?: () => string;
}

function defaultUid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `uid-${Math.random().toString(36).slice(2)}`;
}

export function priceBom(
  bomLines: BomLine[],
  input: { makePreference: MakePreference },
  snapshot: MasterSnapshot,
  options: PriceBomOptions = {},
): PriceBomResult {
  const nextUid = options.uid ?? defaultUid;
  const preferred = preferredTier(input.makePreference);
  const makesByMaterial = new Map<string, Make[]>();
  for (const mk of snapshot.makes) {
    const list = makesByMaterial.get(mk.materialCode) ?? [];
    list.push(mk);
    makesByMaterial.set(mk.materialCode, list);
  }
  const priceByKey = new Map<string, Price>();
  for (const p of snapshot.prices) priceByKey.set(`${p.materialCode}|${p.makeCode}`, p);

  const lines: PricedLineWithCost[] = [];
  const warnings: GenerationWarning[] = [];
  const priceIds: string[] = [];
  const installRateCodes: string[] = [];

  // Section order follows first appearance of each system in the BOM.
  const sectionOrderBySystem = new Map<string, number>();
  const lineCursorBySystem = new Map<string, number>();

  for (const line of bomLines) {
    if (!sectionOrderBySystem.has(line.systemType)) {
      sectionOrderBySystem.set(line.systemType, sectionOrderBySystem.size);
    }
    const sectionOrder = sectionOrderBySystem.get(line.systemType)!;

    const makes = makesByMaterial.get(line.materialCode) ?? [];
    const selection = selectMake(makes, preferred);
    if (!selection) {
      warnings.push({
        kind: "MAKE_UNAVAILABLE",
        message: `No approved or conditional make available for ${line.materialCode}`,
        ruleCode: line.ruleCode,
        materialCode: line.materialCode,
        systemType: line.systemType,
      });
      continue;
    }
    if (selection.usedFallbackTier || selection.usedConditional) {
      warnings.push({
        kind: "MAKE_UNAVAILABLE",
        message:
          `Preferred ${preferred} make unavailable for ${line.materialCode}; ` +
          `used ${selection.make.tier}${selection.usedConditional ? " (Conditional)" : ""} make ${selection.make.brandName}`,
        ruleCode: line.ruleCode,
        materialCode: line.materialCode,
        systemType: line.systemType,
      });
    }

    const price = priceByKey.get(`${line.materialCode}|${selection.make.makeCode}`);
    if (!price) {
      warnings.push({
        kind: "PRICE_MISSING",
        message: `No current price for ${line.materialCode} / ${selection.make.makeCode}`,
        ruleCode: line.ruleCode,
        materialCode: line.materialCode,
        systemType: line.systemType,
      });
      continue;
    }

    const install = resolveInstallRate(snapshot, line);
    let installRatePaise = 0;
    let installAmt = 0;
    let installRateCode: string | null = null;
    let installRateUnit: InstallRateUnit | null = null;
    if (install) {
      installRatePaise = install.ratePaise;
      installAmt = installAmountPaise(install, line.qty);
      installRateCode = install.rateCode;
      installRateUnit = install.unit;
    } else {
      warnings.push({
        kind: "INSTALL_RATE_MISSING",
        message: `No install rate resolvable for ${line.materialCode} (${line.unit})`,
        ruleCode: line.ruleCode,
        materialCode: line.materialCode,
        systemType: line.systemType,
      });
    }

    const supplyRatePaise = price.sellingRatePaise;
    const supplyAmt = lineAmount(line.qty, supplyRatePaise);
    const lineOrder = lineCursorBySystem.get(line.systemType) ?? 0;
    lineCursorBySystem.set(line.systemType, lineOrder + 1);

    lines.push({
      lineUid: nextUid(),
      systemType: line.systemType,
      sectionOrder,
      lineOrder,
      materialCode: line.materialCode,
      description: line.materialName,
      makeCode: selection.make.makeCode,
      brandName: selection.make.brandName,
      qty: line.qty,
      unit: line.unit,
      supplyRatePaise,
      installRatePaise,
      sitcRatePaise: supplyRatePaise + installRatePaise,
      supplyAmountPaise: supplyAmt,
      installAmountPaise: installAmt,
      lineAmountPaise: supplyAmt + installAmt,
      source: "RULE",
      ruleCode: line.ruleCode,
      priceId: price.priceId,
      installRateCode,
      installRateUnit,
      note: null,
      editReason: null,
      buyingRatePaise: price.buyingRatePaise,
    });

    priceIds.push(price.priceId);
    if (installRateCode) installRateCodes.push(installRateCode);
  }

  return { lines, warnings, priceIds, installRateCodes };
}
