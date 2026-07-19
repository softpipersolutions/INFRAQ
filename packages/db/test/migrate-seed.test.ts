import { masterSnapshotSchema, type EnquiryInput } from "@pebble/shared";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/index";
import {
  appendAudit,
  createDb,
  createEnquiry,
  getEnquiry,
  loadMasterSnapshot,
  migrateDb,
  nextEnquiryId,
  nextEstimateId,
} from "../src/index";
import { auditEvents, makes, materialNameEmbeddings, materials } from "../src/schema";
import { freshDb } from "./helpers";

let handle: DbHandle;
beforeEach(async () => {
  handle = await freshDb();
});
afterEach(async () => {
  await handle.close();
});

describe("migrations", () => {
  it("are idempotent (re-running applies nothing)", async () => {
    const { migrateDb } = await import("../src/index");
    const applied = await migrateDb(handle);
    expect(applied).toEqual([]);
  });
});

describe("0002 ingestion commit migration", () => {
  it("applies 0002_ingestion_commit on a fresh database", async () => {
    const fresh = await createDb({ pglite: true, pgliteDir: "memory://" });
    try {
      const applied = await migrateDb(fresh);
      expect(applied).toContain("0002_ingestion_commit.sql");
    } finally {
      await fresh.close();
    }
  });

  it("accepts a STAGED_COMMITTED audit event (the new enum value, null estimate/enquiry refs)", async () => {
    const id = await appendAudit(handle.db, {
      eventType: "STAGED_COMMITTED",
      actor: "reviewer",
      payload: { targetMaster: "prices", stagedRecordId: "01J-staged" },
    });
    const rows = await handle.db.select().from(auditEvents).where(eq(auditEvents.id, id));
    expect(rows[0]?.eventType).toBe("STAGED_COMMITTED");
    expect(rows[0]?.estimateId).toBeNull();
    expect(rows[0]?.enquiryId).toBeNull();
  });

  it("adds a source_provenance column to makes, prices and install_rates", async () => {
    const res = (await handle.db.execute(sql`
      SELECT table_name FROM information_schema.columns
      WHERE column_name = 'source_provenance'
        AND table_name IN ('makes', 'prices', 'install_rates', 'materials')
      ORDER BY table_name
    `)) as unknown as { rows: Array<{ table_name: string }> };
    expect(res.rows.map((r) => r.table_name)).toEqual([
      "install_rates",
      "makes",
      "materials",
      "prices",
    ]);
  });

  it("round-trips source_provenance written onto a committed make", async () => {
    const provenance = { sourceDocumentId: "01J-doc", stagedRecordId: "01J-staged", page: 4 };
    await handle.db.insert(makes).values({
      makeCode: "FAS-SMK-001-PROBE",
      materialCode: "FAS-SMK-001",
      brandName: "Probe Brand",
      tier: "Standard",
      approvalStatus: "Approved",
      sourceProvenance: provenance,
    });
    const rows = await handle.db.select().from(makes).where(eq(makes.makeCode, "FAS-SMK-001-PROBE"));
    expect(rows[0]?.sourceProvenance).toEqual(provenance);
  });

  it("stores a 768-dim material name embedding (FK to a seeded material)", async () => {
    const embedding = Array.from({ length: 768 }, (_, i) => (i % 5) * 0.1);
    await handle.db.insert(materialNameEmbeddings).values({
      materialCode: "FAS-SMK-001",
      embedding,
      model: "text-embedding-004",
    });
    const rows = await handle.db
      .select()
      .from(materialNameEmbeddings)
      .where(eq(materialNameEmbeddings.materialCode, "FAS-SMK-001"));
    expect(rows[0]?.embedding).toHaveLength(768);
    expect(rows[0]?.model).toBe("text-embedding-004");
  });

  it("rejects a wrong-dimension embedding", async () => {
    await expect(
      handle.db.insert(materialNameEmbeddings).values({
        materialCode: "FAS-HEAT-001",
        embedding: [1, 2, 3],
        model: "bad",
      }),
    ).rejects.toThrow();
  });

  it("keeps materials inserts working under the gin_trgm index", async () => {
    await handle.db.insert(materials).values({
      materialCode: "FAS-DET-900",
      materialName: "Aspirating Smoke Detector",
      systemType: "FAS",
      category: "Detector",
      unitOfMeasure: "No.",
    });
    const found = await handle.db.execute(
      sql`SELECT count(*)::int AS c FROM materials WHERE material_name ILIKE '%aspirating%'`,
    );
    expect((found as unknown as { rows: Array<{ c: number }> }).rows[0]?.c).toBe(1);
  });
});

describe("seed → loadMasterSnapshot", () => {
  it("produces a MasterSnapshot that satisfies the shared schema", async () => {
    const snap = await loadMasterSnapshot(handle.db);
    expect(() => masterSnapshotSchema.parse(snap)).not.toThrow();
  });

  it("seeds the expected shape of masters", async () => {
    const snap = await loadMasterSnapshot(handle.db);
    expect(snap.materials.length).toBeGreaterThanOrEqual(28);
    expect(snap.marginMatrix).toHaveLength(4);
    expect(snap.rules.length).toBeGreaterThanOrEqual(25);
    // Every material has an Approved Standard make and a linked install rate.
    for (const m of snap.materials) {
      const std = snap.makes.find(
        (k) => k.materialCode === m.materialCode && k.tier === "Standard" && k.approvalStatus === "Approved",
      );
      expect(std, `material ${m.materialCode} needs an Approved Standard make`).toBeDefined();
      const price = snap.prices.find(
        (p) => p.materialCode === m.materialCode && p.makeCode === std?.makeCode,
      );
      expect(price, `Standard make of ${m.materialCode} needs a current price`).toBeDefined();
      const installRate = snap.installRates.find((r) => r.linkedMaterialCode === m.materialCode);
      expect(installRate, `material ${m.materialCode} needs a linked install rate`).toBeDefined();
    }
  });

  it("resolves money into integer paise (43% install-of-supply invariant)", async () => {
    const snap = await loadMasterSnapshot(handle.db);
    const smoke = snap.prices.find((p) => p.makeCode === "FAS-SMK-001-AGNI");
    expect(smoke?.sellingRatePaise).toBe(145000); // ₹1450.00
    expect(smoke?.buyingRatePaise).toBe(105000); // ₹1050.00
    const smokeInstall = snap.installRates.find((r) => r.rateCode === "INST-FAS-SMK-001");
    // round(145000 × 0.43) = 62350 paise (₹623.50)
    expect(smokeInstall?.ratePaise).toBe(62350);
  });

  it("only exposes currently-effective (open) prices and rates", async () => {
    const snap = await loadMasterSnapshot(handle.db);
    // Exactly one current price per (material, make) seeded.
    const keys = snap.prices.map((p) => `${p.materialCode}|${p.makeCode}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("sequences → business ids", () => {
  it("increments enquiry ids per year in GBE-ENQ-YYYY-NNN format", async () => {
    const a = await nextEnquiryId(handle.db, 2026);
    const b = await nextEnquiryId(handle.db, 2026);
    expect(a).toBe("GBE-ENQ-2026-001");
    expect(b).toBe("GBE-ENQ-2026-002");
  });

  it("keeps enquiry and estimate counters independent, and resets per year", async () => {
    await nextEnquiryId(handle.db, 2026);
    const est = await nextEstimateId(handle.db, 2026);
    expect(est).toBe("GBE-EST-2026-001");
    const nextYear = await nextEnquiryId(handle.db, 2027);
    expect(nextYear).toBe("GBE-ENQ-2027-001");
  });
});

describe("enquiry repository", () => {
  const input: EnquiryInput = {
    clientName: "Acme Retail Pvt Ltd",
    projectName: "Hazratganj Mall",
    buildingType: "Commercial",
    floorsAbove: 4,
    floorAreaSqm: 450,
    systemsRequired: ["FAS", "Extinguisher"],
    makePreference: "As per Greenberg",
    applicableStandard: "IS",
    projectTier: 2,
    clientEmail: null,
    clientPhone: null,
    notes: null,
    source: "form",
  };

  it("creates an enquiry with an id and round-trips it", async () => {
    const created = await createEnquiry(handle.db, input, "dev-admin", {
      now: new Date("2026-07-18T00:00:00Z"),
    });
    expect(created.enquiryId).toBe("GBE-ENQ-2026-001");
    const fetched = await getEnquiry(handle.db, created.enquiryId);
    expect(fetched?.clientName).toBe("Acme Retail Pvt Ltd");
    expect(fetched?.systemsRequired).toEqual(["FAS", "Extinguisher"]);
    expect(fetched?.floorAreaSqm).toBe(450);
  });

  it("writes an ENQ_CREATED audit event in the same transaction", async () => {
    const created = await createEnquiry(handle.db, input, "dev-admin");
    const { auditEvents } = await import("../src/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await handle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.enquiryId, created.enquiryId));
    expect(rows.map((r) => r.eventType)).toContain("ENQ_CREATED");
  });
});
