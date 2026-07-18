import type { Enquiry, EnquiryInput, SystemType } from "@pebble/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { appendAudit } from "./audit";
import { enquiries } from "../schema";
import { nextEnquiryId } from "./sequences";

/**
 * Enquiry repository (A.08). Creating an enquiry allocates its GBE-ENQ id and
 * writes the ENQ_CREATED audit event in the same transaction.
 */

function rowToEnquiry(r: typeof enquiries.$inferSelect): Enquiry {
  return {
    enquiryId: r.enquiryId,
    clientName: r.clientName,
    projectName: r.projectName,
    buildingType: r.buildingType,
    floorsAbove: r.floorsAbove,
    floorAreaSqm: Number(r.floorAreaSqm),
    systemsRequired: r.systemsRequired as Exclude<SystemType, "Common">[],
    makePreference: r.makePreference,
    applicableStandard: r.applicableStandard,
    projectTier: r.projectTier,
    clientEmail: r.clientEmail ?? null,
    clientPhone: r.clientPhone ?? null,
    notes: r.notes ?? null,
    source: r.source,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function createEnquiry(
  db: Db,
  input: EnquiryInput,
  actor: string,
  opts: { now?: Date } = {},
): Promise<Enquiry> {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const enquiryId = await nextEnquiryId(tx as unknown as Db, now.getFullYear());
    const inserted = await tx
      .insert(enquiries)
      .values({
        enquiryId,
        clientName: input.clientName,
        projectName: input.projectName,
        buildingType: input.buildingType,
        floorsAbove: input.floorsAbove,
        floorAreaSqm: String(input.floorAreaSqm),
        systemsRequired: input.systemsRequired,
        makePreference: input.makePreference,
        applicableStandard: input.applicableStandard,
        projectTier: input.projectTier,
        clientEmail: input.clientEmail ?? null,
        clientPhone: input.clientPhone ?? null,
        notes: input.notes ?? null,
        source: input.source,
        createdBy: actor,
        createdAt: now,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("Enquiry insert returned no row");

    await appendAudit(tx as unknown as Db, {
      eventType: "ENQ_CREATED",
      actor,
      enquiryId,
      payload: {
        clientName: input.clientName,
        projectName: input.projectName,
        systemsRequired: input.systemsRequired,
        source: input.source,
      },
    });

    return rowToEnquiry(row);
  });
}

export async function getEnquiry(db: Db, enquiryId: string): Promise<Enquiry | null> {
  const rows = await db.select().from(enquiries).where(eq(enquiries.enquiryId, enquiryId)).limit(1);
  const r = rows[0];
  return r ? rowToEnquiry(r) : null;
}
