import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubEmbedder } from "@pebble/ai";
import type { DbHandle } from "@pebble/db";
import {
  createDb,
  createEnquiry,
  forkWorkingVersion,
  migrateDb,
  persistGeneratedEstimate,
  seedDatabase,
} from "@pebble/db";
import type { EnquiryInput, GenerationResult, PricedLine } from "@pebble/shared";
import type { IngestAiDeps } from "../src/ingest";

/** A freshly migrated + seeded in-memory PGlite database for a single test file. */
export async function freshDb(): Promise<DbHandle> {
  const handle = await createDb({ pglite: true, pgliteDir: "memory://" });
  await migrateDb(handle);
  await seedDatabase(handle.db);
  return handle;
}

/** A unique OS temp dir for a `LocalStorageAdapter` under test. */
export async function tempStorageDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pebble-worker-"));
}

/** Model-less ingest AI deps (deterministic stub embedder) for app-level tests. */
export function stubIngestAi(): IngestAiDeps {
  return { model: null, embedder: new StubEmbedder() };
}

/** A minimal valid enquiry to hang an estimate off. */
export function sampleEnquiry(): EnquiryInput {
  return {
    clientName: "Acme Towers Pvt Ltd",
    projectName: "Acme Commercial Tower — Phase 1",
    buildingType: "Commercial",
    floorsAbove: 4,
    floorAreaSqm: 450,
    systemsRequired: ["FAS", "Extinguisher"],
    makePreference: "Standard",
    applicableStandard: "IS",
    projectTier: 2,
    clientEmail: "projects@acmetowers.example",
    clientPhone: "+91 98111 22333",
    notes: null,
    source: "form",
  };
}

/**
 * A hand-built generation result (2 FAS lines) mirroring
 * `packages/db/test/helpers.ts::fakeGeneration()` — rates follow the SITC × 1.43
 * invariant so the persisted totals are self-consistent. Lets us exercise the
 * render/dispatch handlers without depending on `@pebble/engines`.
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

export interface SeededEstimate {
  enquiryId: string;
  estimateId: string;
  versionId: string;
}

/** Create an enquiry + a LOCKED v1 estimate ready to render. */
export async function createLockedEstimate(handle: DbHandle): Promise<SeededEstimate> {
  const enquiry = await createEnquiry(handle.db, sampleEnquiry(), "tester");
  const { estimateId, versionId } = await persistGeneratedEstimate(handle.db, {
    enquiryId: enquiry.enquiryId,
    generation: fakeGeneration(),
    actor: "tester",
  });
  return { enquiryId: enquiry.enquiryId, estimateId, versionId };
}

/**
 * Fork the LOCKED v1 into a WORKING v2 and make it current — the state the
 * render guard must refuse. Returns the new working version number.
 */
export async function makeCurrentVersionWorking(
  handle: DbHandle,
  estimateId: string,
): Promise<number> {
  const working = await forkWorkingVersion(handle.db, estimateId, "tester");
  return working.versionNo;
}
