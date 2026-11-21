import type { EnquiryInput } from "@pebble/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/index";
import {
  appendAudit,
  approveVersion,
  createEnquiry,
  forkWorkingVersion,
  getEstimate,
  getVersionWithLines,
  insertInstallRate,
  insertPrice,
  listAuditForEstimate,
  listVersions,
  persistGeneratedEstimate,
  updateWorkingLine,
} from "../src/index";
import { auditEvents, estimateVersions } from "../src/schema";
import { fakeGeneration, freshDb } from "./helpers";

let handle: DbHandle;
beforeEach(async () => {
  handle = await freshDb();
});
afterEach(async () => {
  await handle.close();
});

const enquiryInput: EnquiryInput = {
  clientName: "Acme Retail Pvt Ltd",
  projectName: "Contoso Ganj Mall",
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

async function seededEstimate() {
  const enquiry = await createEnquiry(handle.db, enquiryInput, "dev-admin");
  const { estimateId, versionId } = await persistGeneratedEstimate(handle.db, {
    enquiryId: enquiry.enquiryId,
    generation: fakeGeneration(),
    actor: "dev-admin",
  });
  return { enquiry, estimateId, versionId };
}

describe("append-only audit trail", () => {
  it("rejects UPDATE and DELETE on audit_events", async () => {
    const id = await appendAudit(handle.db, {
      eventType: "REVIEW_STARTED",
      actor: "dev-admin",
      payload: { note: "x" },
    });
    await expect(
      handle.db.update(auditEvents).set({ actor: "hacker" }).where(eq(auditEvents.id, id)),
    ).rejects.toThrow();
    await expect(
      handle.db.delete(auditEvents).where(eq(auditEvents.id, id)),
    ).rejects.toThrow();
  });
});

describe("temporal rate integrity (EXCLUDE constraints)", () => {
  it("rejects a second open price for the same (material, make)", async () => {
    await expect(
      insertPrice(handle.db, {
        materialCode: "FAS-SMK-001",
        makeCode: "FAS-SMK-001-AGNI",
        buyingRatePaise: 100000,
        sellingRatePaise: 150000,
        validFrom: new Date("2025-06-01"),
        createdBy: "dev-admin",
      }),
    ).rejects.toThrow();
  });

  it("rejects a second open install rate for the same rate_code", async () => {
    await expect(
      insertInstallRate(handle.db, {
        rateCode: "INST-FAS-SMK-001",
        description: "dup",
        systemType: "FAS",
        linkedMaterialCode: "FAS-SMK-001",
        ratePaise: 50000,
        unit: "Per No.",
        validFrom: new Date("2025-06-01"),
      }),
    ).rejects.toThrow();
  });
});

describe("generation persistence", () => {
  it("writes a LOCKED v1 with lines and correct paise totals", async () => {
    const { estimateId } = await seededEstimate();
    const vwl = await getVersionWithLines(handle.db, estimateId);
    expect(vwl?.version.state).toBe("LOCKED");
    expect(vwl?.version.versionNo).toBe(1);
    expect(vwl?.lines).toHaveLength(2);
    // 30×1450 + 8×950 = ₹51,100.00
    expect(vwl?.version.totalSupplyPaise).toBe(30 * 145000 + 8 * 95000);
    expect(vwl?.version.blendedRatio).toBe(1.43);
    const estimate = await getEstimate(handle.db, estimateId);
    expect(estimate?.sitcStatus).toBe("PASS");
    expect(estimate?.marginStatus).toBe("OK");
  });

  it("emits the generation audit sequence in chronological order", async () => {
    const { estimateId } = await seededEstimate();
    const events = await listAuditForEstimate(handle.db, estimateId);
    const types = events.map((e) => e.eventType);
    expect(types).toContain("GEN_STARTED");
    expect(types).toContain("RULE_APPLIED");
    expect(types).toContain("PRICE_APPLIED");
    expect(types).toContain("SITC_VALIDATED");
    expect(types).toContain("DRAFT_v1_CREATED");
    // ULID ids sort in insertion (chronological) order.
    const ids = events.map((e) => e.id);
    expect([...ids].sort()).toEqual(ids);
    expect(types.indexOf("GEN_STARTED")).toBeLessThan(types.indexOf("DRAFT_v1_CREATED"));
  });
});

describe("LOCKED-version immutability (DB triggers)", () => {
  it("rejects mutation of a LOCKED version row", async () => {
    const { versionId } = await seededEstimate();
    await expect(
      handle.db
        .update(estimateVersions)
        .set({ grandTotal: "1.00" })
        .where(eq(estimateVersions.id, versionId)),
    ).rejects.toThrow();
  });

  it("rejects editing a line belonging to a LOCKED version", async () => {
    const { versionId } = await seededEstimate();
    await expect(
      updateWorkingLine(handle.db, versionId, "uid-smoke", { qty: 999 }, "tampering"),
    ).rejects.toThrow();
  });
});

describe("copy-on-write versioning", () => {
  it("forks a WORKING v2 preserving line_uids", async () => {
    const { estimateId } = await seededEstimate();
    const v1 = await getVersionWithLines(handle.db, estimateId, 1);
    const v2 = await forkWorkingVersion(handle.db, estimateId, "dev-admin");
    expect(v2.state).toBe("WORKING");
    expect(v2.versionNo).toBe(2);
    expect(v2.basedOnVersion).toBe(1);

    const v2full = await getVersionWithLines(handle.db, estimateId, 2);
    const v1Uids = new Set(v1?.lines.map((l) => l.lineUid));
    const v2Uids = new Set(v2full?.lines.map((l) => l.lineUid));
    expect(v2Uids).toEqual(v1Uids);
    // The estimate's current version advances to the working copy.
    const estimate = await getEstimate(handle.db, estimateId);
    expect(estimate?.currentVersion).toBe(2);
    expect(estimate?.status).toBe("IN_REVIEW");
  });

  it("allows editing a WORKING line, then locks it on approval", async () => {
    const { estimateId } = await seededEstimate();
    const v2 = await forkWorkingVersion(handle.db, estimateId, "dev-admin");

    await updateWorkingLine(handle.db, v2.id, "uid-smoke", { qty: 32 }, "site recount");
    const edited = await getVersionWithLines(handle.db, estimateId, 2);
    const smoke = edited?.lines.find((l) => l.lineUid === "uid-smoke");
    expect(smoke?.qty).toBe(32);
    expect(smoke?.editReason).toBe("site recount");

    await approveVersion(handle.db, estimateId, "dev-admin");
    const approved = await getEstimate(handle.db, estimateId);
    expect(approved?.status).toBe("APPROVED");
    const versions = await listVersions(handle.db, estimateId);
    expect(versions.find((v) => v.versionNo === 2)?.state).toBe("LOCKED");

    // Now v2 is locked → further edits are rejected by the trigger.
    await expect(
      updateWorkingLine(handle.db, v2.id, "uid-smoke", { qty: 40 }, "too late"),
    ).rejects.toThrow();
  });
});
