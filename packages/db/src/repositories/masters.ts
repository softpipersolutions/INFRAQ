import type {
  DesignRule,
  InstallRate,
  Make,
  MarginRow,
  MasterSnapshot,
  Material,
  MaterialSpec,
  Price,
  SystemType,
} from "@pebble/shared";
import { toPaise } from "@pebble/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../client";
import { newUlid } from "../ids";
import {
  designRules,
  installRates,
  makes,
  marginMatrix,
  materialSpecs,
  materials,
  prices,
} from "../schema";

/**
 * Master-data repositories (A.01–A.07). Reads resolve the *current* temporal
 * row (valid_to IS NULL) and hand back the engine-facing shapes from
 * @pebble/shared — money already converted to integer paise. The engines never
 * see NUMERIC strings or validity ranges.
 */

// ─── Materials / specs / makes ──────────────────────────────────────────────

export async function insertMaterial(
  db: Db,
  m: Material & { sourceProvenance?: Record<string, unknown> | null },
): Promise<void> {
  await db.insert(materials).values({
    materialCode: m.materialCode,
    materialName: m.materialName,
    systemType: m.systemType,
    category: m.category,
    unitOfMeasure: m.unitOfMeasure,
    active: m.active,
    sourceProvenance: m.sourceProvenance ?? null,
  });
}

export async function insertMaterialSpec(db: Db, s: MaterialSpec): Promise<void> {
  await db.insert(materialSpecs).values(s);
}

export async function insertMake(db: Db, mk: Make): Promise<void> {
  await db.insert(makes).values(mk);
}

export async function listMaterials(db: Db): Promise<Material[]> {
  const rows = await db.select().from(materials);
  return rows.map((r) => ({
    materialCode: r.materialCode,
    materialName: r.materialName,
    systemType: r.systemType,
    category: r.category,
    unitOfMeasure: r.unitOfMeasure,
    active: r.active,
  }));
}

// ─── Prices (temporal) ──────────────────────────────────────────────────────

export interface NewPrice {
  materialCode: string;
  makeCode: string;
  buyingRatePaise: number;
  sellingRatePaise: number;
  validFrom: Date;
  createdBy: string;
}

/** Rupee string for a NUMERIC(14,2) column from integer paise. */
function paiseToNumeric(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Insert a fresh open-ended price row. Assumes no current row exists for the
 * key (seed path). Use setCurrentPrice to supersede an existing rate.
 */
export async function insertPrice(db: Db, p: NewPrice): Promise<string> {
  const priceId = newUlid();
  await db.insert(prices).values({
    priceId,
    materialCode: p.materialCode,
    makeCode: p.makeCode,
    buyingRate: paiseToNumeric(p.buyingRatePaise),
    sellingRate: paiseToNumeric(p.sellingRatePaise),
    validFrom: p.validFrom,
    validTo: null,
    createdBy: p.createdBy,
  });
  return priceId;
}

/**
 * Supersede the current rate: close the open row (valid_to = effectiveFrom)
 * then insert the new open row — the EXCLUDE constraint guarantees no overlap.
 */
export async function setCurrentPrice(db: Db, p: NewPrice): Promise<string> {
  return db.transaction(async (tx) => {
    await tx
      .update(prices)
      .set({ validTo: p.validFrom })
      .where(
        and(
          eq(prices.materialCode, p.materialCode),
          eq(prices.makeCode, p.makeCode),
          isNull(prices.validTo),
        ),
      );
    return insertPrice(tx as unknown as Db, p);
  });
}

// ─── Install rates (temporal) ───────────────────────────────────────────────

export interface NewInstallRate {
  rateCode: string;
  description: string;
  systemType: SystemType;
  linkedMaterialCode: string | null;
  ratePaise: number;
  unit: InstallRate["unit"];
  validFrom: Date;
}

export async function insertInstallRate(db: Db, r: NewInstallRate): Promise<string> {
  const id = newUlid();
  await db.insert(installRates).values({
    id,
    rateCode: r.rateCode,
    description: r.description,
    systemType: r.systemType,
    linkedMaterialCode: r.linkedMaterialCode,
    rate: paiseToNumeric(r.ratePaise),
    unit: r.unit,
    validFrom: r.validFrom,
    validTo: null,
  });
  return id;
}

// ─── Design rules (versioned) ───────────────────────────────────────────────

export interface NewDesignRule {
  ruleCode: string;
  systemType: SystemType;
  conditionExpr: string;
  conditionAst: unknown;
  quantityFormula: string;
  quantityAst: unknown;
  outputMaterialCode: string;
  standardReference: string | null;
  createdBy: string;
}

/** Insert version 1 of a rule (seed path). */
export async function insertRule(db: Db, r: NewDesignRule): Promise<string> {
  const ruleId = newUlid();
  await db.insert(designRules).values({
    ruleId,
    ruleCode: r.ruleCode,
    ruleVersion: 1,
    systemType: r.systemType,
    conditionExpr: r.conditionExpr,
    conditionAst: r.conditionAst,
    quantityFormula: r.quantityFormula,
    quantityAst: r.quantityAst,
    outputMaterialCode: r.outputMaterialCode,
    standardReference: r.standardReference,
    active: true,
    createdBy: r.createdBy,
  });
  return ruleId;
}

// ─── Margin matrix ──────────────────────────────────────────────────────────

export async function insertMarginRow(db: Db, m: MarginRow): Promise<void> {
  await db.insert(marginMatrix).values({
    tier: m.tier,
    tierLabel: m.tierLabel,
    targetMarginPct: String(m.targetMarginPct),
    floorMarginPct: String(m.floorMarginPct),
    discountAuthority: m.discountAuthority,
  });
}

// ─── Engine-facing snapshot ─────────────────────────────────────────────────

/**
 * Load everything the deterministic engines need, resolved as of *now*
 * (current temporal rows), mapped into the frozen @pebble/shared shapes with
 * money in integer paise. This is the single bridge between the database and
 * the pure engines.
 */
export async function loadMasterSnapshot(db: Db): Promise<MasterSnapshot> {
  const [materialRows, specRows, makeRows, priceRows, installRows, ruleRows, marginRows] =
    await Promise.all([
      db.select().from(materials),
      db.select().from(materialSpecs),
      db.select().from(makes),
      db.select().from(prices).where(isNull(prices.validTo)),
      db.select().from(installRates).where(isNull(installRates.validTo)),
      db.select().from(designRules).where(eq(designRules.active, true)),
      db.select().from(marginMatrix),
    ]);

  const mappedMaterials: Material[] = materialRows.map((r) => ({
    materialCode: r.materialCode,
    materialName: r.materialName,
    systemType: r.systemType,
    category: r.category,
    unitOfMeasure: r.unitOfMeasure,
    active: r.active,
  }));

  const specs: MaterialSpec[] = specRows.map((r) => ({
    materialCode: r.materialCode,
    applicableStandard: r.applicableStandard ?? null,
    rating: r.rating ?? null,
    size: r.size ?? null,
    certifications: r.certifications ?? [],
    complianceNotes: r.complianceNotes ?? null,
  }));

  const mappedMakes: Make[] = makeRows.map((r) => ({
    makeCode: r.makeCode,
    materialCode: r.materialCode,
    brandName: r.brandName,
    tier: r.tier,
    approvalStatus: r.approvalStatus,
    notes: r.notes ?? null,
  }));

  const mappedPrices: Price[] = priceRows.map((r) => ({
    priceId: r.priceId,
    materialCode: r.materialCode,
    makeCode: r.makeCode,
    buyingRatePaise: toPaise(r.buyingRate, `price ${r.priceId} buying`),
    sellingRatePaise: toPaise(r.sellingRate, `price ${r.priceId} selling`),
    effectiveFrom: r.validFrom.toISOString(),
  }));

  const mappedInstallRates: InstallRate[] = installRows.map((r) => ({
    rateCode: r.rateCode,
    description: r.description,
    systemType: r.systemType,
    linkedMaterialCode: r.linkedMaterialCode ?? null,
    ratePaise: toPaise(r.rate, `install rate ${r.rateCode}`),
    unit: r.unit,
    effectiveFrom: r.validFrom.toISOString(),
  }));

  const rules: DesignRule[] = ruleRows.map((r) => ({
    ruleId: r.ruleId,
    ruleCode: r.ruleCode,
    ruleVersion: r.ruleVersion,
    systemType: r.systemType,
    conditionExpr: r.conditionExpr,
    quantityFormula: r.quantityFormula,
    outputMaterialCode: r.outputMaterialCode,
    standardReference: r.standardReference ?? null,
    active: r.active,
  }));

  const margin: MarginRow[] = marginRows.map((r) => ({
    tier: r.tier,
    tierLabel: r.tierLabel,
    targetMarginPct: Number(r.targetMarginPct),
    floorMarginPct: Number(r.floorMarginPct),
    discountAuthority: r.discountAuthority,
  }));

  return {
    materials: mappedMaterials,
    specs,
    makes: mappedMakes,
    prices: mappedPrices,
    installRates: mappedInstallRates,
    rules,
    marginMatrix: margin,
  };
}
