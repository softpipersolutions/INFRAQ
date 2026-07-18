import type {
  EstimateStatus,
  GenerationResult,
  MarginStatus,
  PricedLine,
  SitcStatus,
} from "@pebble/shared";
import type { DiscountAuthority, InstallRateUnit, LineSource } from "@pebble/shared";
import { paiseToNumericString, toPaise } from "@pebble/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { newUlid } from "../ids";
import { appendAudit } from "./audit";
import { estimateLines, estimateVersions, estimates } from "../schema";
import { nextEstimateId } from "./sequences";

/**
 * Estimate / version / line repository.
 *
 * Versioning is copy-on-write: generation writes v1 LOCKED immediately; the
 * first edit forks a WORKING v2 that preserves each line's line_uid (so version
 * compare is a pure join); approval locks the working version. Immutability is
 * enforced at the database level by the 0001 triggers — this repo simply never
 * tries to mutate a LOCKED row.
 */

export interface EstimateRow {
  estimateId: string;
  enquiryId: string;
  status: EstimateStatus;
  currentVersion: number;
  sitcStatus: SitcStatus | null;
  marginStatus: MarginStatus | null;
  requiredAuthority: DiscountAuthority | null;
}

export interface VersionRow {
  id: string;
  estimateId: string;
  versionNo: number;
  state: "WORKING" | "LOCKED";
  basedOnVersion: number | null;
  totalSupplyPaise: number;
  totalInstallPaise: number;
  totalSitcPaise: number;
  blendedRatio: number | null;
  marginPct: number | null;
  gstPaise: number;
  grandTotalPaise: number;
  snapshot: Record<string, unknown> | null;
}

export interface VersionWithLines {
  estimate: EstimateRow;
  version: VersionRow;
  lines: PricedLine[];
}

function rowToEstimate(r: typeof estimates.$inferSelect): EstimateRow {
  return {
    estimateId: r.estimateId,
    enquiryId: r.enquiryId,
    status: r.status,
    currentVersion: r.currentVersion,
    sitcStatus: r.sitcStatus ?? null,
    marginStatus: r.marginStatus ?? null,
    requiredAuthority: r.requiredAuthority ?? null,
  };
}

function rowToVersion(r: typeof estimateVersions.$inferSelect): VersionRow {
  return {
    id: r.id,
    estimateId: r.estimateId,
    versionNo: r.versionNo,
    state: r.state,
    basedOnVersion: r.basedOnVersion ?? null,
    totalSupplyPaise: toPaise(r.totalSupply, "version total_supply"),
    totalInstallPaise: toPaise(r.totalInstall, "version total_install"),
    totalSitcPaise: toPaise(r.totalSitc, "version total_sitc"),
    blendedRatio: r.blendedRatio === null ? null : Number(r.blendedRatio),
    marginPct: r.marginPct === null ? null : Number(r.marginPct),
    gstPaise: toPaise(r.gstAmount, "version gst"),
    grandTotalPaise: toPaise(r.grandTotal, "version grand_total"),
    snapshot: r.generationSnapshot ?? null,
  };
}

function rowToPricedLine(r: typeof estimateLines.$inferSelect): PricedLine {
  return {
    lineUid: r.lineUid,
    systemType: r.systemType,
    sectionOrder: r.sectionOrder,
    lineOrder: r.lineOrder,
    materialCode: r.materialCode,
    description: r.description,
    makeCode: r.makeCode ?? null,
    brandName: r.brandName ?? null,
    qty: Number(r.qty),
    unit: r.unit,
    supplyRatePaise: toPaise(r.supplyRate, "line supply_rate"),
    installRatePaise: toPaise(r.installRate, "line install_rate"),
    sitcRatePaise: toPaise(r.sitcRate, "line sitc_rate"),
    supplyAmountPaise: toPaise(r.supplyAmount, "line supply_amount"),
    installAmountPaise: toPaise(r.installAmount, "line install_amount"),
    lineAmountPaise: toPaise(r.lineAmount, "line line_amount"),
    source: r.source as LineSource,
    ruleCode: r.ruleCode ?? null,
    priceId: r.priceId ?? null,
    installRateCode: r.installRateCode ?? null,
    installRateUnit: (r.installRateUnit as InstallRateUnit | null) ?? null,
    note: r.note ?? null,
    editReason: r.editReason ?? null,
  };
}

/** Column values for one persisted line (shared by generation + fork copy). */
function lineValues(versionId: string, line: PricedLine): typeof estimateLines.$inferInsert {
  return {
    id: newUlid(),
    estimateVersionId: versionId,
    lineUid: line.lineUid,
    systemType: line.systemType,
    sectionOrder: line.sectionOrder,
    lineOrder: line.lineOrder,
    materialCode: line.materialCode,
    description: line.description,
    makeCode: line.makeCode,
    brandName: line.brandName,
    qty: String(line.qty),
    unit: line.unit,
    supplyRate: paiseToNumericString(line.supplyRatePaise),
    installRate: paiseToNumericString(line.installRatePaise),
    sitcRate: paiseToNumericString(line.sitcRatePaise),
    supplyAmount: paiseToNumericString(line.supplyAmountPaise),
    installAmount: paiseToNumericString(line.installAmountPaise),
    lineAmount: paiseToNumericString(line.lineAmountPaise),
    source: line.source,
    ruleCode: line.ruleCode,
    priceId: line.priceId,
    installRateCode: line.installRateCode,
    installRateUnit: line.installRateUnit,
    note: line.note,
    editReason: line.editReason,
  };
}

export interface PersistGenerationArgs {
  enquiryId: string;
  generation: GenerationResult;
  actor: string;
  actorRole?: string | null;
  now?: Date;
}

/**
 * Persist a deterministic generation as estimate + LOCKED v1 + lines, emitting
 * the generation audit events (GEN_STARTED → RULE_APPLIED* → PRICE_APPLIED* →
 * SITC_VALIDATED → DRAFT_v1_CREATED) in the same transaction.
 */
export async function persistGeneratedEstimate(
  db: Db,
  args: PersistGenerationArgs,
): Promise<{ estimateId: string; versionId: string }> {
  const { enquiryId, generation, actor } = args;
  const now = args.now ?? new Date();
  const actorRole = args.actorRole ?? null;

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const estimateId = await nextEstimateId(tx, now.getFullYear());
    const versionId = newUlid();
    const { totals, sitc, margin } = generation;

    await tx.insert(estimates).values({
      estimateId,
      enquiryId,
      status: "DRAFT",
      currentVersion: 1,
      sitcStatus: sitc.status,
      marginStatus: margin.status,
      requiredAuthority: margin.requiredAuthority,
      createdAt: now,
      updatedAt: now,
    });

    await appendAudit(tx, {
      eventType: "GEN_STARTED",
      actor,
      actorRole,
      estimateId,
      enquiryId,
      version: 1,
      payload: { enquiryId, engineVersion: generation.snapshot.engineVersion },
    });

    await tx.insert(estimateVersions).values({
      id: versionId,
      estimateId,
      versionNo: 1,
      state: "LOCKED",
      basedOnVersion: null,
      generationSnapshot: {
        ...generation.snapshot,
        warnings: generation.warnings,
      },
      totalSupply: paiseToNumericString(totals.totalSupplyPaise),
      totalInstall: paiseToNumericString(totals.totalInstallPaise),
      totalSitc: paiseToNumericString(totals.totalSitcPaise),
      blendedRatio: totals.blendedRatio === null ? null : String(totals.blendedRatio),
      marginPct: margin.marginPct === null ? null : String(margin.marginPct),
      gstAmount: paiseToNumericString(totals.gstPaise),
      grandTotal: paiseToNumericString(totals.grandTotalPaise),
      createdBy: actor,
      createdAt: now,
      lockedAt: now,
      lockedBy: actor,
    });

    if (generation.lines.length > 0) {
      await tx
        .insert(estimateLines)
        .values(generation.lines.map((line) => lineValues(versionId, line)));
    }

    for (const rule of generation.appliedRules) {
      await appendAudit(tx, {
        eventType: "RULE_APPLIED",
        actor,
        actorRole,
        estimateId,
        enquiryId,
        version: 1,
        payload: { ...rule },
      });
    }
    for (const line of generation.lines) {
      await appendAudit(tx, {
        eventType: "PRICE_APPLIED",
        actor,
        actorRole,
        estimateId,
        version: 1,
        payload: {
          lineUid: line.lineUid,
          materialCode: line.materialCode,
          makeCode: line.makeCode,
          priceId: line.priceId,
          supplyRatePaise: line.supplyRatePaise,
          installRateCode: line.installRateCode,
          installRatePaise: line.installRatePaise,
        },
      });
    }

    await appendAudit(tx, {
      eventType: "SITC_VALIDATED",
      actor,
      actorRole,
      estimateId,
      version: 1,
      payload: { ...sitc },
    });
    await appendAudit(tx, {
      eventType: "DRAFT_v1_CREATED",
      actor,
      actorRole,
      estimateId,
      version: 1,
      payload: { versionId, totals, warnings: generation.warnings.length },
    });

    return { estimateId, versionId };
  });
}

export async function getEstimate(db: Db, estimateId: string): Promise<EstimateRow | null> {
  const rows = await db.select().from(estimates).where(eq(estimates.estimateId, estimateId)).limit(1);
  const r = rows[0];
  return r ? rowToEstimate(r) : null;
}

export async function listVersions(db: Db, estimateId: string): Promise<VersionRow[]> {
  const rows = await db
    .select()
    .from(estimateVersions)
    .where(eq(estimateVersions.estimateId, estimateId))
    .orderBy(asc(estimateVersions.versionNo));
  return rows.map(rowToVersion);
}

/** Fetch a version (defaults to the estimate's current version) with its lines. */
export async function getVersionWithLines(
  db: Db,
  estimateId: string,
  versionNo?: number,
): Promise<VersionWithLines | null> {
  const estimate = await getEstimate(db, estimateId);
  if (!estimate) return null;
  const targetVersion = versionNo ?? estimate.currentVersion;

  const versionRows = await db
    .select()
    .from(estimateVersions)
    .where(
      and(
        eq(estimateVersions.estimateId, estimateId),
        eq(estimateVersions.versionNo, targetVersion),
      ),
    )
    .limit(1);
  const versionRow = versionRows[0];
  if (!versionRow) return null;

  const lineRows = await db
    .select()
    .from(estimateLines)
    .where(eq(estimateLines.estimateVersionId, versionRow.id))
    .orderBy(asc(estimateLines.sectionOrder), asc(estimateLines.lineOrder));

  return {
    estimate,
    version: rowToVersion(versionRow),
    lines: lineRows.map(rowToPricedLine),
  };
}

/**
 * Fork the current LOCKED version into a new WORKING version (copy-on-write).
 * Line uids are preserved so version compare is a pure join. Idempotent-ish:
 * if the current version is already WORKING, it is returned unchanged.
 */
export async function forkWorkingVersion(
  db: Db,
  estimateId: string,
  actor: string,
  actorRole: string | null = null,
): Promise<VersionRow> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const current = await getVersionWithLines(tx, estimateId);
    if (!current) throw new Error(`Estimate ${estimateId} not found`);
    if (current.version.state === "WORKING") return current.version;

    const newVersionNo = current.version.versionNo + 1;
    const newVersionId = newUlid();
    const src = current.version;

    await tx.insert(estimateVersions).values({
      id: newVersionId,
      estimateId,
      versionNo: newVersionNo,
      state: "WORKING",
      basedOnVersion: src.versionNo,
      generationSnapshot: src.snapshot,
      totalSupply: paiseToNumericString(src.totalSupplyPaise),
      totalInstall: paiseToNumericString(src.totalInstallPaise),
      totalSitc: paiseToNumericString(src.totalSitcPaise),
      blendedRatio: src.blendedRatio === null ? null : String(src.blendedRatio),
      marginPct: src.marginPct === null ? null : String(src.marginPct),
      gstAmount: paiseToNumericString(src.gstPaise),
      grandTotal: paiseToNumericString(src.grandTotalPaise),
      createdBy: actor,
    });

    if (current.lines.length > 0) {
      await tx
        .insert(estimateLines)
        .values(current.lines.map((line) => lineValues(newVersionId, line)));
    }

    await tx
      .update(estimates)
      .set({ currentVersion: newVersionNo, status: "IN_REVIEW", updatedAt: new Date() })
      .where(eq(estimates.estimateId, estimateId));

    await appendAudit(tx, {
      eventType: "REVIEW_STARTED",
      actor,
      actorRole,
      estimateId,
      version: newVersionNo,
      payload: { basedOnVersion: src.versionNo },
    });

    const [row] = await tx
      .select()
      .from(estimateVersions)
      .where(eq(estimateVersions.id, newVersionId))
      .limit(1);
    return rowToVersion(row!);
  });
}

/** Approve (lock) a WORKING version and mark the estimate APPROVED. */
export async function approveVersion(
  db: Db,
  estimateId: string,
  actor: string,
  actorRole: string | null = null,
): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const current = await getVersionWithLines(tx, estimateId);
    if (!current) throw new Error(`Estimate ${estimateId} not found`);
    if (current.version.state !== "WORKING") {
      throw new Error(`Version ${current.version.versionNo} is not WORKING; cannot approve`);
    }
    const now = new Date();
    await tx
      .update(estimateVersions)
      .set({ state: "LOCKED", lockedAt: now, lockedBy: actor })
      .where(eq(estimateVersions.id, current.version.id));
    await tx
      .update(estimates)
      .set({ status: "APPROVED", updatedAt: now })
      .where(eq(estimates.estimateId, estimateId));
    await appendAudit(tx, {
      eventType: "EST_APPROVED",
      actor,
      actorRole,
      estimateId,
      version: current.version.versionNo,
      payload: { versionNo: current.version.versionNo },
    });
  });
}

export interface LineEdit {
  qty?: number;
  makeCode?: string | null;
  brandName?: string | null;
  supplyRatePaise?: number;
  installRatePaise?: number;
  sitcRatePaise?: number;
  supplyAmountPaise?: number;
  installAmountPaise?: number;
  lineAmountPaise?: number;
  description?: string;
  note?: string | null;
}

/**
 * Update editable fields of a line by line_uid on the current WORKING version.
 * Blocked by the DB trigger if the version is LOCKED. Recomputing version
 * totals after edits is the caller's (engine's) job.
 */
export async function updateWorkingLine(
  db: Db,
  versionId: string,
  lineUid: string,
  edit: LineEdit,
  editReason: string,
): Promise<void> {
  const set: Partial<typeof estimateLines.$inferInsert> = { editReason };
  if (edit.qty !== undefined) set.qty = String(edit.qty);
  if (edit.makeCode !== undefined) set.makeCode = edit.makeCode;
  if (edit.brandName !== undefined) set.brandName = edit.brandName;
  if (edit.description !== undefined) set.description = edit.description;
  if (edit.note !== undefined) set.note = edit.note;
  if (edit.supplyRatePaise !== undefined) set.supplyRate = paiseToNumericString(edit.supplyRatePaise);
  if (edit.installRatePaise !== undefined)
    set.installRate = paiseToNumericString(edit.installRatePaise);
  if (edit.sitcRatePaise !== undefined) set.sitcRate = paiseToNumericString(edit.sitcRatePaise);
  if (edit.supplyAmountPaise !== undefined)
    set.supplyAmount = paiseToNumericString(edit.supplyAmountPaise);
  if (edit.installAmountPaise !== undefined)
    set.installAmount = paiseToNumericString(edit.installAmountPaise);
  if (edit.lineAmountPaise !== undefined) set.lineAmount = paiseToNumericString(edit.lineAmountPaise);

  await db
    .update(estimateLines)
    .set(set)
    .where(
      and(eq(estimateLines.estimateVersionId, versionId), eq(estimateLines.lineUid, lineUid)),
    );
}
