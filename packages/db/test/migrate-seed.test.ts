import { masterSnapshotSchema, type EnquiryInput } from "@pebble/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/index";
import {
  createEnquiry,
  getEnquiry,
  loadMasterSnapshot,
  nextEnquiryId,
  nextEstimateId,
} from "../src/index";
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
