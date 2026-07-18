import "server-only";

import { schema, type Db } from "@pebble/db";
import type {
  DispatchChannel,
  DispatchStatus,
  DocumentKind,
  EstimateStatus,
} from "@pebble/shared";

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

export interface GeneratedDocumentListItem {
  id: string;
  versionNo: number;
  docType: DocumentKind;
  uri: string;
  sha256: string;
  generatedBy: string;
  createdAt: string;
}

/**
 * Rendered outputs for an estimate (all versions), newest first. Documents hang
 * off versions, so the version rows provide the estimate filter + version
 * labels; ids are monotonic ULIDs, so sorting by id desc is exact time order.
 */
export async function listDocumentsForEstimate(
  db: Db,
  estimateId: string,
): Promise<GeneratedDocumentListItem[]> {
  const [documents, versions] = await Promise.all([
    db.select().from(schema.generatedDocuments),
    db.select().from(schema.estimateVersions),
  ]);
  const versionById = new Map(
    versions.filter((v) => v.estimateId === estimateId).map((v) => [v.id, v]),
  );

  return documents
    .filter((d) => versionById.has(d.estimateVersionId))
    .map((d) => ({
      id: d.id,
      versionNo: versionById.get(d.estimateVersionId)!.versionNo,
      docType: d.kind,
      uri: d.storageUri,
      sha256: d.sha256,
      generatedBy: d.generatedBy,
      createdAt: d.createdAt.toISOString(),
    }))
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

export interface DispatchListItem {
  id: string;
  channel: DispatchChannel;
  recipient: string;
  provider: string;
  status: DispatchStatus;
  providerMessageId: string | null;
  error: string | null;
  documentIds: string[];
  createdBy: string;
  createdAt: string;
}

/** Outbox history for an estimate, newest first (monotonic ULID ids). */
export async function listDispatchesForEstimate(
  db: Db,
  estimateId: string,
): Promise<DispatchListItem[]> {
  const rows = await db.select().from(schema.dispatches);
  return rows
    .filter((r) => r.estimateId === estimateId)
    .map((r) => ({
      id: r.id,
      channel: r.channel,
      recipient: r.recipient,
      provider: r.provider,
      status: r.status,
      providerMessageId: r.providerMessageId ?? null,
      error: r.error ?? null,
      documentIds: r.documentIds,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    }))
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}
