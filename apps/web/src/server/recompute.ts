import "server-only";

import {
  addWorkingLine,
  appendAudit,
  forkWorkingVersion,
  getEnquiry,
  getEstimate,
  getVersionWithLines,
  loadMasterSnapshot,
  removeWorkingLine,
  setEstimateStatus,
  updateWorkingLine,
  updateWorkingVersionAggregates,
  type Db,
  type LineEdit,
  type VersionWithLines,
} from "@pebble/db";
import {
  computeMargin,
  computeTotals,
  priceBom,
  validateSitc,
} from "@pebble/engines";
import type {
  BomLine,
  MarginResult,
  MasterSnapshot,
  PricedLine,
  SitcStatus,
} from "@pebble/shared";
import { lineAmount } from "@pebble/shared";

/**
 * Edit-recompute service for WORKING versions.
 *
 * Every mutation (edit / add / remove line) runs the same deterministic
 * recompute of the whole version with the pure engines and persists the fresh
 * aggregates + estimate header status in the same call, then appends the audit
 * event. Money is only ever computed here (server), never in the client.
 */

export interface Actor {
  actor: string;
  actorRole: string | null;
}

/** Ensure the estimate's current version is WORKING, forking a copy if LOCKED. */
async function ensureWorking(
  db: Db,
  estimateId: string,
  who: Actor,
): Promise<VersionWithLines> {
  const current = await getVersionWithLines(db, estimateId);
  if (!current) throw new Error(`Estimate ${estimateId} not found`);
  if (current.version.state === "WORKING") return current;

  await forkWorkingVersion(db, estimateId, who.actor, who.actorRole);
  const forked = await getVersionWithLines(db, estimateId);
  if (!forked) throw new Error(`Estimate ${estimateId} disappeared after fork`);
  return forked;
}

/** Buying-rate lookups (paise) keyed by priceId and by materialCode|makeCode. */
function buyingRateMaps(snapshot: MasterSnapshot): {
  byPriceId: Map<string, number>;
  byMaterialMake: Map<string, number>;
} {
  const byPriceId = new Map<string, number>();
  const byMaterialMake = new Map<string, number>();
  for (const p of snapshot.prices) {
    byPriceId.set(p.priceId, p.buyingRatePaise);
    byMaterialMake.set(`${p.materialCode}|${p.makeCode}`, p.buyingRatePaise);
  }
  return { byPriceId, byMaterialMake };
}

function resolveBuyingRate(
  line: PricedLine,
  maps: ReturnType<typeof buyingRateMaps>,
): number | null {
  if (line.priceId) {
    const byId = maps.byPriceId.get(line.priceId);
    if (byId !== undefined) return byId;
  }
  if (line.makeCode) {
    const byMake = maps.byMaterialMake.get(`${line.materialCode}|${line.makeCode}`);
    if (byMake !== undefined) return byMake;
  }
  return null;
}

/**
 * Recompute SITC / margin / totals over the current working lines and persist
 * the version aggregates and estimate header status. Returns the fresh summary.
 */
async function recomputeVersion(
  db: Db,
  estimateId: string,
  versionId: string,
  marginTier: number,
  snapshot: MasterSnapshot,
): Promise<{
  sitcStatus: SitcStatus;
  margin: MarginResult;
  totalSitcPaise: number;
  blendedRatio: number | null;
}> {
  const refreshed = await getVersionWithLines(db, estimateId);
  const lines = refreshed?.lines ?? [];

  const sitc = validateSitc(lines);
  const totals = computeTotals(sitc);

  const maps = buyingRateMaps(snapshot);
  const marginRow = snapshot.marginMatrix.find((m) => m.tier === marginTier);
  let margin: MarginResult = { marginPct: null, status: "OK", requiredAuthority: null };
  if (marginRow) {
    const marginLines: { qty: number; supplyAmountPaise: number; buyingRatePaise: number }[] = [];
    let complete = true;
    for (const l of lines) {
      const buy = resolveBuyingRate(l, maps);
      if (buy === null) {
        complete = false;
        break;
      }
      marginLines.push({ qty: l.qty, supplyAmountPaise: l.supplyAmountPaise, buyingRatePaise: buy });
    }
    if (complete && marginLines.length > 0) {
      margin = computeMargin(marginLines, marginRow);
    }
  }

  await updateWorkingVersionAggregates(db, versionId, {
    totalSupplyPaise: totals.totalSupplyPaise,
    totalInstallPaise: totals.totalInstallPaise,
    totalSitcPaise: totals.totalSitcPaise,
    gstPaise: totals.gstPaise,
    grandTotalPaise: totals.grandTotalPaise,
    blendedRatio: totals.blendedRatio,
    marginPct: margin.marginPct,
  });

  await setEstimateStatus(db, estimateId, {
    status: "IN_REVIEW",
    sitcStatus: sitc.status,
    marginStatus: margin.status,
    requiredAuthority: margin.requiredAuthority,
  });

  return {
    sitcStatus: sitc.status,
    margin,
    totalSitcPaise: totals.totalSitcPaise,
    blendedRatio: totals.blendedRatio,
  };
}

async function marginTierFor(db: Db, estimateId: string, enquiryId: string): Promise<number> {
  const enquiry = await getEnquiry(db, enquiryId);
  if (enquiry) return enquiry.projectTier;
  const estimate = await getEstimate(db, estimateId);
  return estimate ? 1 : 1;
}

export interface EditLineArgs {
  estimateId: string;
  lineUid: string;
  qty?: number;
  makeCode?: string;
  note?: string | null;
  editReason: string;
}

/** Edit a WORKING line's qty / make / note, recompute money + the whole version. */
export async function editLine(db: Db, who: Actor, args: EditLineArgs): Promise<void> {
  const working = await ensureWorking(db, args.estimateId, who);
  const versionId = working.version.id;
  const current = working.lines.find((l) => l.lineUid === args.lineUid);
  if (!current) throw new Error(`Line ${args.lineUid} not found on the working version`);

  const snapshot = await loadMasterSnapshot(db);

  const qty = args.qty ?? current.qty;
  let supplyRatePaise = current.supplyRatePaise;
  let makeCode = current.makeCode;
  let brandName = current.brandName;

  if (args.makeCode && args.makeCode !== current.makeCode) {
    const price = snapshot.prices.find(
      (p) => p.materialCode === current.materialCode && p.makeCode === args.makeCode,
    );
    const make = snapshot.makes.find(
      (m) => m.materialCode === current.materialCode && m.makeCode === args.makeCode,
    );
    if (!price || !make) {
      throw new Error(`No current price for ${current.materialCode} / ${args.makeCode}`);
    }
    supplyRatePaise = price.sellingRatePaise;
    makeCode = make.makeCode;
    brandName = make.brandName;
  }

  const installRatePaise = current.installRatePaise;
  const flatInstall = current.installRateUnit === "Lumpsum" || current.installRateUnit === "Per Floor";
  const installAmountPaise = flatInstall ? installRatePaise : lineAmount(qty, installRatePaise);
  const supplyAmountPaise = lineAmount(qty, supplyRatePaise);

  const edit: LineEdit = {
    qty,
    makeCode,
    brandName,
    supplyRatePaise,
    installRatePaise,
    sitcRatePaise: supplyRatePaise + installRatePaise,
    supplyAmountPaise,
    installAmountPaise,
    lineAmountPaise: supplyAmountPaise + installAmountPaise,
  };
  if (args.note !== undefined) edit.note = args.note;

  await updateWorkingLine(db, versionId, args.lineUid, edit, args.editReason);

  const tier = await marginTierFor(db, args.estimateId, working.estimate.enquiryId);
  await recomputeVersion(db, args.estimateId, versionId, tier, snapshot);

  await appendAudit(db, {
    eventType: "LINE_EDITED",
    actor: who.actor,
    actorRole: who.actorRole,
    estimateId: args.estimateId,
    version: working.version.versionNo,
    payload: {
      lineUid: args.lineUid,
      materialCode: current.materialCode,
      qty,
      makeCode,
      editReason: args.editReason,
    },
  });
}

export interface AddLineArgs {
  estimateId: string;
  materialCode: string;
  qty: number;
  note?: string | null;
  editReason: string;
}

/** Add a MANUAL line (make auto-selected by the enquiry's preference), recompute. */
export async function addLine(db: Db, who: Actor, args: AddLineArgs): Promise<void> {
  const working = await ensureWorking(db, args.estimateId, who);
  const versionId = working.version.id;
  const snapshot = await loadMasterSnapshot(db);

  const material = snapshot.materials.find((m) => m.materialCode === args.materialCode);
  if (!material) throw new Error(`Unknown material ${args.materialCode}`);

  const enquiry = await getEnquiry(db, working.estimate.enquiryId);
  const makePreference = enquiry?.makePreference ?? "Standard";

  const bom: BomLine = {
    systemType: material.systemType,
    materialCode: material.materialCode,
    materialName: material.materialName,
    unit: material.unitOfMeasure,
    qty: args.qty,
    ruleCode: "",
    ruleId: "",
    standardReference: null,
  };

  const priced = priceBom([bom], { makePreference }, snapshot);
  const first = priced.lines[0];
  if (!first) {
    const reason = priced.warnings[0]?.message ?? "no make or price available";
    throw new Error(`Cannot price ${args.materialCode}: ${reason}`);
  }

  // Section/line ordering: reuse the system's existing section, else append.
  const sameSystem = working.lines.filter((l) => l.systemType === material.systemType);
  const sectionOrder =
    sameSystem[0]?.sectionOrder ??
    (working.lines.reduce((max, l) => Math.max(max, l.sectionOrder), -1) + 1);
  const lineOrder = sameSystem.reduce((max, l) => Math.max(max, l.lineOrder), -1) + 1;

  const uid =
    (globalThis.crypto?.randomUUID?.() as string | undefined) ??
    `uid-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const { buyingRatePaise: _drop, ...pricedLine } = first;
  const line: PricedLine = {
    ...pricedLine,
    lineUid: uid,
    sectionOrder,
    lineOrder,
    source: "MANUAL",
    ruleCode: null,
    note: args.note ?? null,
    editReason: args.editReason,
  };

  await addWorkingLine(db, versionId, line);

  await recomputeVersion(
    db,
    args.estimateId,
    versionId,
    await marginTierFor(db, args.estimateId, working.estimate.enquiryId),
    snapshot,
  );

  await appendAudit(db, {
    eventType: "LINE_ADDED",
    actor: who.actor,
    actorRole: who.actorRole,
    estimateId: args.estimateId,
    version: working.version.versionNo,
    payload: { lineUid: uid, materialCode: args.materialCode, qty: args.qty, editReason: args.editReason },
  });
}

export interface RemoveLineArgs {
  estimateId: string;
  lineUid: string;
  editReason: string;
}

/** Remove a WORKING line, recompute the version. */
export async function removeLine(db: Db, who: Actor, args: RemoveLineArgs): Promise<void> {
  const working = await ensureWorking(db, args.estimateId, who);
  const versionId = working.version.id;
  const current = working.lines.find((l) => l.lineUid === args.lineUid);
  if (!current) throw new Error(`Line ${args.lineUid} not found on the working version`);

  await removeWorkingLine(db, versionId, args.lineUid);

  const snapshot = await loadMasterSnapshot(db);
  await recomputeVersion(
    db,
    args.estimateId,
    versionId,
    await marginTierFor(db, args.estimateId, working.estimate.enquiryId),
    snapshot,
  );

  await appendAudit(db, {
    eventType: "LINE_REMOVED",
    actor: who.actor,
    actorRole: who.actorRole,
    estimateId: args.estimateId,
    version: working.version.versionNo,
    payload: { lineUid: args.lineUid, materialCode: current.materialCode, editReason: args.editReason },
  });
}
