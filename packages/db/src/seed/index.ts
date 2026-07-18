import { parseExpression } from "@pebble/expr";
import type { Db } from "../client";
import {
  insertInstallRate,
  insertMake,
  insertMarginRow,
  insertMaterial,
  insertMaterialSpec,
  insertPrice,
  insertRule,
} from "../repositories/masters";
import { ensureDevUser } from "../repositories/users";
import {
  INSTALL_RATE_FRACTION,
  SEED_MARGIN_MATRIX,
  SEED_MATERIALS,
  SEED_RULES,
  type SeedMaterial,
} from "./data";

/** Whole rupees → integer paise. */
function rupToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** The Approved Standard make — the tier chosen for make_preference "As per Greenberg". */
function standardMake(m: SeedMaterial): SeedMaterial["makes"][number] {
  const std = m.makes.find((k) => k.tier === "Standard" && k.approval === "Approved");
  if (!std) {
    throw new Error(`Seed integrity: material ${m.code} has no Approved Standard make`);
  }
  return std;
}

export interface SeedResult {
  materials: number;
  makes: number;
  prices: number;
  installRates: number;
  rules: number;
  marginRows: number;
}

export interface SeedOptions {
  actor?: string;
  /** Effective-from for all seeded temporal rows. */
  validFrom?: Date;
}

/**
 * Seed the starter master dataset. Assumes an empty (freshly migrated)
 * database. Rule expressions are parsed through @pebble/expr so a malformed
 * seed rule fails loudly here rather than at generation time; the parsed AST is
 * stored alongside the source.
 */
export async function seedDatabase(db: Db, opts: SeedOptions = {}): Promise<SeedResult> {
  const actor = opts.actor ?? "seed";
  const validFrom = opts.validFrom ?? new Date("2024-01-01T00:00:00.000Z");

  const materialCodes = new Set(SEED_MATERIALS.map((m) => m.code));
  const result: SeedResult = {
    materials: 0,
    makes: 0,
    prices: 0,
    installRates: 0,
    rules: 0,
    marginRows: 0,
  };

  await ensureDevUser(db);

  for (const row of SEED_MARGIN_MATRIX) {
    await insertMarginRow(db, row);
    result.marginRows += 1;
  }

  for (const m of SEED_MATERIALS) {
    await insertMaterial(db, {
      materialCode: m.code,
      materialName: m.name,
      systemType: m.system,
      category: m.category,
      unitOfMeasure: m.unit,
      active: true,
      sourceProvenance: null,
    });
    result.materials += 1;

    await insertMaterialSpec(db, {
      materialCode: m.code,
      applicableStandard: m.standard,
      rating: m.rating,
      size: m.size,
      certifications: m.certifications,
      complianceNotes: null,
    });

    for (const mk of m.makes) {
      await insertMake(db, {
        makeCode: mk.makeCode,
        materialCode: m.code,
        brandName: mk.brand,
        tier: mk.tier,
        approvalStatus: mk.approval,
        notes: null,
      });
      result.makes += 1;

      await insertPrice(db, {
        materialCode: m.code,
        makeCode: mk.makeCode,
        buyingRatePaise: rupToPaise(mk.buy),
        sellingRatePaise: rupToPaise(mk.sell),
        validFrom,
        createdBy: actor,
      });
      result.prices += 1;
    }

    // Material-linked install rate = 43% of the Standard selling rate → every
    // priced line's SITC ratio is exactly Supply × 1.43.
    const std = standardMake(m);
    await insertInstallRate(db, {
      rateCode: `INST-${m.code}`,
      description: `Installation, testing & commissioning — ${m.name}`,
      systemType: m.system,
      linkedMaterialCode: m.code,
      ratePaise: Math.round(rupToPaise(std.sell) * INSTALL_RATE_FRACTION),
      unit: m.installUnit,
      validFrom,
    });
    result.installRates += 1;
  }

  for (const r of SEED_RULES) {
    if (!materialCodes.has(r.outputMaterialCode)) {
      throw new Error(
        `Seed integrity: rule ${r.ruleCode} outputs unknown material ${r.outputMaterialCode}`,
      );
    }
    await insertRule(db, {
      ruleCode: r.ruleCode,
      systemType: r.system,
      conditionExpr: r.condition,
      conditionAst: parseExpression(r.condition, "condition"),
      quantityFormula: r.quantity,
      quantityAst: parseExpression(r.quantity, "quantity"),
      outputMaterialCode: r.outputMaterialCode,
      standardReference: r.standardReference,
      createdBy: actor,
    });
    result.rules += 1;
  }

  return result;
}
