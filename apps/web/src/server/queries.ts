import "server-only";

import { schema, type Db } from "@pebble/db";
import type { EstimateStatus } from "@pebble/shared";

/**
 * Small read helpers for list/dashboard screens. These do simple table selects
 * (no repo function exists for cross-cutting lists) and sort/aggregate in JS —
 * the dataset is small and this keeps the web layer free of drizzle operator
 * imports.
 */

export interface EnquiryListItem {
  enquiryId: string;
  clientName: string;
  projectName: string;
  buildingType: string;
  systemsRequired: string[];
  projectTier: number;
  createdAt: string;
}

export async function listEnquiries(db: Db): Promise<EnquiryListItem[]> {
  const rows = await db.select().from(schema.enquiries);
  return rows
    .map((r) => ({
      enquiryId: r.enquiryId,
      clientName: r.clientName,
      projectName: r.projectName,
      buildingType: r.buildingType,
      systemsRequired: r.systemsRequired,
      projectTier: r.projectTier,
      createdAt: r.createdAt.toISOString(),
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export interface EstimateListItem {
  estimateId: string;
  enquiryId: string;
  projectName: string;
  clientName: string;
  status: EstimateStatus;
  sitcStatus: string | null;
  marginStatus: string | null;
  currentVersion: number;
  grandTotalPaise: number | null;
  createdAt: string;
}

export async function listEstimates(db: Db): Promise<EstimateListItem[]> {
  const [estimates, enquiries, versions] = await Promise.all([
    db.select().from(schema.estimates),
    db.select().from(schema.enquiries),
    db.select().from(schema.estimateVersions),
  ]);

  const enquiryById = new Map(enquiries.map((e) => [e.enquiryId, e]));
  // Latest version total per estimate (highest versionNo).
  const latestByEstimate = new Map<string, (typeof versions)[number]>();
  for (const v of versions) {
    const prev = latestByEstimate.get(v.estimateId);
    if (!prev || v.versionNo > prev.versionNo) latestByEstimate.set(v.estimateId, v);
  }

  return estimates
    .map((r) => {
      const enq = enquiryById.get(r.enquiryId);
      const ver = latestByEstimate.get(r.estimateId);
      return {
        estimateId: r.estimateId,
        enquiryId: r.enquiryId,
        projectName: enq?.projectName ?? "—",
        clientName: enq?.clientName ?? "—",
        status: r.status,
        sitcStatus: r.sitcStatus ?? null,
        marginStatus: r.marginStatus ?? null,
        currentVersion: r.currentVersion,
        grandTotalPaise: ver ? Math.round(Number(ver.grandTotal) * 100) : null,
        createdAt: r.createdAt.toISOString(),
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export interface DashboardStats {
  enquiryCount: number;
  estimateCount: number;
  byStatus: Record<string, number>;
  recent: EstimateListItem[];
}

export async function dashboardStats(db: Db): Promise<DashboardStats> {
  const [enquiries, estimates] = await Promise.all([listEnquiries(db), listEstimates(db)]);
  const byStatus: Record<string, number> = {};
  for (const e of estimates) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  }
  return {
    enquiryCount: enquiries.length,
    estimateCount: estimates.length,
    byStatus,
    recent: estimates.slice(0, 8),
  };
}
