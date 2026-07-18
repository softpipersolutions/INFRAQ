import type { GenerationResult, PricedLine } from "@pebble/shared";
import { createDb, migrateDb, seedDatabase, type DbHandle } from "../src/index";

/** A freshly migrated (and optionally seeded) in-memory PGlite database. */
export async function freshDb(opts: { seed?: boolean } = {}): Promise<DbHandle> {
  const handle = await createDb({ pglite: true, pgliteDir: "memory://" });
  await migrateDb(handle);
  if (opts.seed ?? true) await seedDatabase(handle.db);
  return handle;
}

/**
 * A hand-built generation result (2 FAS lines) for exercising persistence and
 * immutability without depending on @pebble/engines. Rates follow the seed's
 * SITC × 1.43 invariant so the totals are self-consistent.
 */
export function fakeGeneration(): GenerationResult {
  const lines: PricedLine[] = [
    {
      lineUid: "uid-smoke",
      systemType: "FAS",
      sectionOrder: 0,
      lineOrder: 0,
      materialCode: "FAS-SMK-001",
      description: "Photoelectric Smoke Detector — Agni Devices",
      makeCode: "FAS-SMK-001-AGNI",
      brandName: "Agni Devices",
      qty: 30,
      unit: "No.",
      supplyRatePaise: 145000,
      installRatePaise: 62350,
      sitcRatePaise: 207350,
      supplyAmountPaise: 30 * 145000,
      installAmountPaise: 30 * 62350,
      lineAmountPaise: 30 * 145000 + 30 * 62350,
      source: "RULE",
      ruleCode: "DL-FAS-001",
      priceId: null,
      installRateCode: "INST-FAS-SMK-001",
      installRateUnit: "Per No.",
      note: null,
      editReason: null,
    },
    {
      lineUid: "uid-mcp",
      systemType: "FAS",
      sectionOrder: 0,
      lineOrder: 1,
      materialCode: "FAS-MCP-001",
      description: "Manual Call Point — Agni Devices",
      makeCode: "FAS-MCP-001-AGNI",
      brandName: "Agni Devices",
      qty: 8,
      unit: "No.",
      supplyRatePaise: 95000,
      installRatePaise: 40850,
      sitcRatePaise: 135850,
      supplyAmountPaise: 8 * 95000,
      installAmountPaise: 8 * 40850,
      lineAmountPaise: 8 * 95000 + 8 * 40850,
      source: "RULE",
      ruleCode: "DL-FAS-003",
      priceId: null,
      installRateCode: "INST-FAS-MCP-001",
      installRateUnit: "Per No.",
      note: null,
      editReason: null,
    },
  ];

  const totalSupply = lines.reduce((s, l) => s + l.supplyAmountPaise, 0);
  const totalInstall = lines.reduce((s, l) => s + l.installAmountPaise, 0);
  const totalSitc = totalSupply + totalInstall;
  const gst = Math.round(totalSitc * 0.18);

  return {
    lines,
    appliedRules: [
      {
        ruleId: "rule-1",
        ruleCode: "DL-FAS-001",
        ruleVersion: 1,
        conditionExpr: "system = FAS",
        quantityFormula: "CEIL(total_area_sqm / 60)",
        quantityResult: 30,
        outputMaterialCode: "FAS-SMK-001",
        standardReference: "IS 2189",
      },
    ],
    warnings: [],
    sitc: {
      totalSupplyPaise: totalSupply,
      totalInstallPaise: totalInstall,
      totalSitcPaise: totalSitc,
      blendedRatio: 1.43,
      status: "PASS",
    },
    margin: { marginPct: 27.5, status: "OK", requiredAuthority: null },
    totals: {
      totalSupplyPaise: totalSupply,
      totalInstallPaise: totalInstall,
      totalSitcPaise: totalSitc,
      gstPaise: gst,
      grandTotalPaise: totalSitc + gst,
      blendedRatio: 1.43,
    },
    snapshot: {
      ruleIds: ["rule-1"],
      priceIds: [],
      installRateCodes: ["INST-FAS-SMK-001", "INST-FAS-MCP-001"],
      marginTier: 2,
      engineVersion: "test",
    },
  };
}
