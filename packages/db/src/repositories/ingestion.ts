import {
  MATERIAL_CATEGORIES,
  STAGED_RECORD_STATUSES,
  proposeMaterialCode,
  sourceProvenanceSchema,
  stagedPayloadSchemaFor,
  toPaise,
  type ApprovalStatus,
  type InstallRateUnit,
  type MakeTier,
  type MaterialCategory,
  type SourceDocStatus,
  type StagedInstallRate,
  type StagedMakeLink,
  type StagedMaterialBundle,
  type StagedPricePoint,
  type StagedRecordStatus,
  type SystemType,
  type TargetMaster,
  type UnitOfMeasure,
} from "@pebble/shared";
import { paiseToNumericString } from "@pebble/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client";
import { newUlid } from "../ids";
import {
  extractionRuns,
  installRates,
  makes,
  materials,
  prices,
  ragChunks,
  sourceDocuments,
  stagedRecords,
} from "../schema";
import { appendAudit } from "./audit";
import { insertMaterial, insertMaterialSpec } from "./masters";
import { trgmMaterialCandidates, upsertMaterialNameEmbedding } from "./rag";

/**
 * Ingestion persistence (Phase B, spec §E): register source documents → track
 * extraction runs → stage proposed rows → serve the human verification queue →
 * commit approved rows into the masters WITH provenance.
 *
 * Every function takes `db: Db` first so it composes inside a `db.transaction`
 * (the house style — see enquiries/estimates repos). Money crosses the boundary
 * as raw rupees (shared payloads) and is converted to the integer-paise /
 * NUMERIC(14,2) discipline here via @pebble/shared money utils.
 */

// ─── Threshold / convention constants ───────────────────────────────────────

/** trigram similarity at/above which a proposed material is treated as a dedup. */
const DEDUP_SIMILARITY_THRESHOLD = 0.82;
/** Fallback unit-of-measure for a material whose source unit did not normalize. */
const DEFAULT_UNIT_OF_MEASURE: UnitOfMeasure = "No.";
/** New makes discovered from a document default to Conditional until vetted. */
const INGESTED_MAKE_APPROVAL: ApprovalStatus = "Conditional";
const DEFAULT_MAKE_TIER: MakeTier = "Standard";

// ─── Source documents ───────────────────────────────────────────────────────

export interface RegisterSourceDocumentArgs {
  filename: string;
  storageUri: string;
  docType: string;
  fileRef?: string | null;
  revision?: string | null;
  docDate?: Date | null;
  sourceEntity?: string | null;
  pageCount?: number | null;
}

export interface SourceDocumentRow {
  id: string;
  filename: string;
  storageUri: string;
  docType: string;
  fileRef: string | null;
  revision: string | null;
  docDate: Date | null;
  sourceEntity: string | null;
  pageCount: number | null;
  status: SourceDocStatus;
  createdAt: Date;
}

function rowToSourceDocument(r: typeof sourceDocuments.$inferSelect): SourceDocumentRow {
  return {
    id: r.id,
    filename: r.filename,
    storageUri: r.storageUri,
    docType: r.docType,
    fileRef: r.fileRef ?? null,
    revision: r.revision ?? null,
    docDate: r.docDate ?? null,
    sourceEntity: r.sourceEntity ?? null,
    pageCount: r.pageCount ?? null,
    status: r.status as SourceDocStatus,
    createdAt: r.createdAt,
  };
}

/**
 * Idempotent on storageUri (unique index): returns the existing document if one
 * is already registered for the URI, otherwise inserts a fresh REGISTERED row.
 */
export async function registerSourceDocument(
  db: Db,
  args: RegisterSourceDocumentArgs,
): Promise<{ id: string; existing: boolean }> {
  const found = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.storageUri, args.storageUri))
    .limit(1);
  if (found[0]) return { id: found[0].id, existing: true };

  const id = newUlid();
  await db.insert(sourceDocuments).values({
    id,
    filename: args.filename,
    storageUri: args.storageUri,
    docType: args.docType,
    fileRef: args.fileRef ?? null,
    revision: args.revision ?? null,
    docDate: args.docDate ?? null,
    sourceEntity: args.sourceEntity ?? null,
    pageCount: args.pageCount ?? null,
    status: "REGISTERED",
  });
  return { id, existing: false };
}

export async function getSourceDocument(db: Db, id: string): Promise<SourceDocumentRow | null> {
  const rows = await db.select().from(sourceDocuments).where(eq(sourceDocuments.id, id)).limit(1);
  return rows[0] ? rowToSourceDocument(rows[0]) : null;
}

export async function getSourceDocumentByUri(
  db: Db,
  uri: string,
): Promise<SourceDocumentRow | null> {
  const rows = await db
    .select()
    .from(sourceDocuments)
    .where(eq(sourceDocuments.storageUri, uri))
    .limit(1);
  return rows[0] ? rowToSourceDocument(rows[0]) : null;
}

/** Zeroed staged-status tally with every status key present. */
function emptyStagedCounts(): Record<StagedRecordStatus, number> {
  return Object.fromEntries(STAGED_RECORD_STATUSES.map((s) => [s, 0])) as Record<
    StagedRecordStatus,
    number
  >;
}

export interface SourceDocumentListItem extends SourceDocumentRow {
  stagedCounts: Record<StagedRecordStatus, number>;
  chunkCount: number;
}

/** All documents (newest first) with their staged-record tallies and chunk counts. */
export async function listSourceDocuments(db: Db): Promise<SourceDocumentListItem[]> {
  const docs = await db.select().from(sourceDocuments).orderBy(desc(sourceDocuments.createdAt));

  const stagedGroups = await db
    .select({
      sourceDocumentId: extractionRuns.sourceDocumentId,
      status: stagedRecords.status,
      n: sql<number>`count(*)::int`,
    })
    .from(stagedRecords)
    .innerJoin(extractionRuns, eq(stagedRecords.extractionRunId, extractionRuns.id))
    .groupBy(extractionRuns.sourceDocumentId, stagedRecords.status);

  const chunkGroups = await db
    .select({
      sourceDocumentId: ragChunks.sourceDocumentId,
      n: sql<number>`count(*)::int`,
    })
    .from(ragChunks)
    .groupBy(ragChunks.sourceDocumentId);

  const stagedByDoc = new Map<string, Record<StagedRecordStatus, number>>();
  for (const g of stagedGroups) {
    const counts = stagedByDoc.get(g.sourceDocumentId) ?? emptyStagedCounts();
    counts[g.status as StagedRecordStatus] = Number(g.n);
    stagedByDoc.set(g.sourceDocumentId, counts);
  }
  const chunkByDoc = new Map(chunkGroups.map((g) => [g.sourceDocumentId, Number(g.n)]));

  return docs.map((d) => ({
    ...rowToSourceDocument(d),
    stagedCounts: stagedByDoc.get(d.id) ?? emptyStagedCounts(),
    chunkCount: chunkByDoc.get(d.id) ?? 0,
  }));
}

export async function setSourceDocumentStatus(
  db: Db,
  id: string,
  status: SourceDocStatus,
  opts: { pageCount?: number } = {},
): Promise<void> {
  const set: Partial<typeof sourceDocuments.$inferInsert> = { status };
  if (opts.pageCount !== undefined) set.pageCount = opts.pageCount;
  await db.update(sourceDocuments).set(set).where(eq(sourceDocuments.id, id));
}

// ─── Extraction runs ────────────────────────────────────────────────────────

export interface StartExtractionRunArgs {
  sourceDocumentId: string;
  model: string;
  promptVersion: string;
}

export async function startExtractionRun(db: Db, args: StartExtractionRunArgs): Promise<string> {
  const id = newUlid();
  await db.insert(extractionRuns).values({
    id,
    sourceDocumentId: args.sourceDocumentId,
    model: args.model,
    promptVersion: args.promptVersion,
    status: "RUNNING",
  });
  return id;
}

export async function finishExtractionRun(
  db: Db,
  id: string,
  args: { status: "SUCCEEDED" | "FAILED"; costUsd?: number },
): Promise<void> {
  await db
    .update(extractionRuns)
    .set({
      status: args.status,
      finishedAt: new Date(),
      // NUMERIC(10,6) — drizzle numeric columns bind as strings (see masters repo).
      costUsd: args.costUsd === undefined ? undefined : String(args.costUsd),
    })
    .where(eq(extractionRuns.id, id));
}

// ─── Staged records ─────────────────────────────────────────────────────────

export interface NewStagedRecord {
  targetMaster: TargetMaster;
  proposed: Record<string, unknown>;
  confidence: number | null;
  dedupCandidateCode?: string | null;
  sourceLocator?: Record<string, unknown> | null;
}

/**
 * Insert a batch of proposed staged rows, validating each `proposed` against the
 * schema for its target master. Throws with the failing record's index (and the
 * zod message) so a bad extraction surfaces loudly rather than staging garbage.
 */
export async function insertStagedRecords(
  db: Db,
  runId: string,
  records: NewStagedRecord[],
): Promise<number> {
  records.forEach((rec, i) => {
    const result = stagedPayloadSchemaFor(rec.targetMaster).safeParse(rec.proposed);
    if (!result.success) {
      throw new Error(
        `staged record[${i}] invalid for target "${rec.targetMaster}": ${result.error.message}`,
      );
    }
  });
  if (records.length === 0) return 0;
  await db.insert(stagedRecords).values(
    records.map((rec) => ({
      id: newUlid(),
      extractionRunId: runId,
      targetMaster: rec.targetMaster,
      proposed: rec.proposed,
      confidence: rec.confidence === null ? null : String(rec.confidence),
      dedupCandidateCode: rec.dedupCandidateCode ?? null,
      sourceLocator: rec.sourceLocator ?? null,
      status: "PROPOSED" as const,
    })),
  );
  return records.length;
}

/**
 * Delete only the still-PROPOSED staged rows belonging to this document's runs;
 * reviewed rows (APPROVED/EDITED_APPROVED/REJECTED/MERGED) are left untouched so
 * a re-extraction can safely replace only what a human has not yet decided on.
 */
export async function deleteProposedForDocument(
  db: Db,
  sourceDocumentId: string,
): Promise<number> {
  const runRows = await db
    .select({ id: extractionRuns.id })
    .from(extractionRuns)
    .where(eq(extractionRuns.sourceDocumentId, sourceDocumentId));
  if (runRows.length === 0) return 0;
  const runIds = runRows.map((r) => r.id);
  const toDelete = await db
    .select({ id: stagedRecords.id })
    .from(stagedRecords)
    .where(and(inArray(stagedRecords.extractionRunId, runIds), eq(stagedRecords.status, "PROPOSED")));
  if (toDelete.length === 0) return 0;
  await db.delete(stagedRecords).where(
    inArray(
      stagedRecords.id,
      toDelete.map((r) => r.id),
    ),
  );
  return toDelete.length;
}

export interface StagedRecordRow {
  id: string;
  extractionRunId: string;
  targetMaster: TargetMaster;
  proposed: Record<string, unknown>;
  confidence: number | null;
  dedupCandidateCode: string | null;
  sourceLocator: Record<string, unknown> | null;
  status: StagedRecordStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface QueueItem extends StagedRecordRow {
  filename: string;
  fileRef: string | null;
  sourceDocumentId: string;
}

export interface QueueFilter {
  status?: StagedRecordStatus[];
  targetMaster?: TargetMaster;
  sourceDocumentId?: string;
  minConfidence?: number;
  limit?: number;
  offset?: number;
}

/**
 * The verification queue: staged rows joined back to their source document,
 * ordered (status, createdAt) — the 0002 `staged_records_status_created_idx`.
 */
export async function listQueue(db: Db, filter: QueueFilter): Promise<QueueItem[]> {
  const conds = [];
  if (filter.status && filter.status.length > 0)
    conds.push(inArray(stagedRecords.status, filter.status));
  if (filter.targetMaster) conds.push(eq(stagedRecords.targetMaster, filter.targetMaster));
  if (filter.sourceDocumentId)
    conds.push(eq(extractionRuns.sourceDocumentId, filter.sourceDocumentId));
  if (filter.minConfidence !== undefined)
    conds.push(sql`${stagedRecords.confidence} >= ${filter.minConfidence}`);

  const rows = await db
    .select({
      id: stagedRecords.id,
      extractionRunId: stagedRecords.extractionRunId,
      targetMaster: stagedRecords.targetMaster,
      proposed: stagedRecords.proposed,
      confidence: stagedRecords.confidence,
      dedupCandidateCode: stagedRecords.dedupCandidateCode,
      sourceLocator: stagedRecords.sourceLocator,
      status: stagedRecords.status,
      reviewedBy: stagedRecords.reviewedBy,
      reviewedAt: stagedRecords.reviewedAt,
      createdAt: stagedRecords.createdAt,
      filename: sourceDocuments.filename,
      fileRef: sourceDocuments.fileRef,
      sourceDocumentId: sourceDocuments.id,
    })
    .from(stagedRecords)
    .innerJoin(extractionRuns, eq(stagedRecords.extractionRunId, extractionRuns.id))
    .innerJoin(sourceDocuments, eq(extractionRuns.sourceDocumentId, sourceDocuments.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(stagedRecords.status), asc(stagedRecords.createdAt))
    .limit(filter.limit ?? 100)
    .offset(filter.offset ?? 0);

  return rows.map((r) => ({
    id: r.id,
    extractionRunId: r.extractionRunId,
    targetMaster: r.targetMaster as TargetMaster,
    proposed: r.proposed,
    confidence: r.confidence === null ? null : Number(r.confidence),
    dedupCandidateCode: r.dedupCandidateCode ?? null,
    sourceLocator: r.sourceLocator ?? null,
    status: r.status,
    reviewedBy: r.reviewedBy ?? null,
    reviewedAt: r.reviewedAt ?? null,
    createdAt: r.createdAt,
    filename: r.filename,
    fileRef: r.fileRef ?? null,
    sourceDocumentId: r.sourceDocumentId,
  }));
}

/** Reject a still-PROPOSED staged row. Throws if it was already reviewed. */
export async function rejectStagedRecord(
  db: Db,
  args: { stagedRecordId: string; reviewer: string },
): Promise<void> {
  const rows = await db
    .select()
    .from(stagedRecords)
    .where(eq(stagedRecords.id, args.stagedRecordId))
    .limit(1);
  const staged = rows[0];
  if (!staged) throw new Error(`staged record ${args.stagedRecordId} not found`);
  if (staged.status !== "PROPOSED")
    throw new Error(`staged record ${args.stagedRecordId} already reviewed (${staged.status})`);
  await db
    .update(stagedRecords)
    .set({ status: "REJECTED", reviewedBy: args.reviewer, reviewedAt: new Date() })
    .where(eq(stagedRecords.id, args.stagedRecordId));
}

// ─── Temporal historical inserts ────────────────────────────────────────────

export interface InsertHistoricalPriceArgs {
  materialCode: string;
  makeCode: string;
  sellPaise: number;
  buyPaise?: number | null;
  validFrom: Date;
  createdBy?: string;
  sourceProvenance?: Record<string, unknown> | null;
}

/**
 * Insert a price into the (material, make) validity timeline at `validFrom`,
 * placing it correctly among any existing rows:
 *  - the row whose range strictly contains validFrom is closed at validFrom;
 *  - the new row's valid_to is the next later row's valid_from (or null → it
 *    becomes the current open rate).
 * Handles empty timelines, insert-before-earliest, insert-between and
 * insert-after-latest. An exact-duplicate valid_from is NOT special-cased, so
 * the gist EXCLUDE constraint surfaces it as a thrown error (never swallowed).
 * When buyPaise is absent the buying rate defaults to the selling rate.
 */
export async function insertHistoricalPrice(db: Db, args: InsertHistoricalPriceArgs): Promise<string> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const existing = await tx
      .select({ priceId: prices.priceId, validFrom: prices.validFrom, validTo: prices.validTo })
      .from(prices)
      .where(and(eq(prices.materialCode, args.materialCode), eq(prices.makeCode, args.makeCode)))
      .orderBy(asc(prices.validFrom));

    const v = args.validFrom.getTime();
    const toClose = existing.find(
      (r) => r.validFrom.getTime() < v && (r.validTo === null || r.validTo.getTime() > v),
    );
    const nextLater = existing.find((r) => r.validFrom.getTime() > v);
    const newValidTo = nextLater ? nextLater.validFrom : null;

    if (toClose) {
      await tx
        .update(prices)
        .set({ validTo: args.validFrom })
        .where(eq(prices.priceId, toClose.priceId));
    }

    const priceId = newUlid();
    const buyPaise = args.buyPaise ?? args.sellPaise;
    await tx.insert(prices).values({
      priceId,
      materialCode: args.materialCode,
      makeCode: args.makeCode,
      buyingRate: paiseToNumericString(buyPaise),
      sellingRate: paiseToNumericString(args.sellPaise),
      validFrom: args.validFrom,
      validTo: newValidTo,
      createdBy: args.createdBy ?? "ingestion",
      sourceProvenance: args.sourceProvenance ?? null,
    });
    return priceId;
  });
}

export interface InsertHistoricalInstallRateArgs {
  rateCode: string;
  description: string;
  systemType: SystemType;
  linkedMaterialCode?: string | null;
  ratePaise: number;
  unit: InstallRateUnit;
  validFrom: Date;
  sourceProvenance?: Record<string, unknown> | null;
}

/**
 * Temporal insert for install_rates — the same timeline placement as
 * insertHistoricalPrice, but keyed by rate_code (its EXCLUDE constraint is on
 * (rate_code, tstzrange)).
 */
export async function insertHistoricalInstallRate(
  db: Db,
  args: InsertHistoricalInstallRateArgs,
): Promise<string> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const existing = await tx
      .select({ id: installRates.id, validFrom: installRates.validFrom, validTo: installRates.validTo })
      .from(installRates)
      .where(eq(installRates.rateCode, args.rateCode))
      .orderBy(asc(installRates.validFrom));

    const v = args.validFrom.getTime();
    const toClose = existing.find(
      (r) => r.validFrom.getTime() < v && (r.validTo === null || r.validTo.getTime() > v),
    );
    const nextLater = existing.find((r) => r.validFrom.getTime() > v);
    const newValidTo = nextLater ? nextLater.validFrom : null;

    if (toClose) {
      await tx
        .update(installRates)
        .set({ validTo: args.validFrom })
        .where(eq(installRates.id, toClose.id));
    }

    const id = newUlid();
    await tx.insert(installRates).values({
      id,
      rateCode: args.rateCode,
      description: args.description,
      systemType: args.systemType,
      linkedMaterialCode: args.linkedMaterialCode ?? null,
      rate: paiseToNumericString(args.ratePaise),
      unit: args.unit,
      validFrom: args.validFrom,
      validTo: newValidTo,
      sourceProvenance: args.sourceProvenance ?? null,
    });
    return id;
  });
}

// ─── Commit helpers ─────────────────────────────────────────────────────────

interface BrandRef {
  raw: string;
  normalized: string | null;
}

/** `PREFIX` for a new make code = the normalized (or raw) brand, A–Z0–9, ≤4 chars. */
function makeAbbrev(brand: string): string {
  const cleaned = brand.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.slice(0, 4) || "GEN";
}

/** `{materialCode}-{ABBR}`, bumped with a numeric suffix on collision. */
function deriveMakeCode(materialCode: string, brand: string, existing: ReadonlySet<string>): string {
  const stem = `${materialCode}-${makeAbbrev(brand)}`;
  if (!existing.has(stem)) return stem;
  let n = 2;
  while (existing.has(`${stem}-${n}`)) n += 1;
  return `${stem}-${n}`;
}

async function assertMaterialExists(db: Db, materialCode: string): Promise<void> {
  const rows = await db
    .select({ c: materials.materialCode })
    .from(materials)
    .where(eq(materials.materialCode, materialCode))
    .limit(1);
  if (!rows[0]) throw new Error(`commit: material ${materialCode} does not exist`);
}

/**
 * Return the make code for (materialCode, brand), reusing an existing make with
 * a case-insensitive brand match or creating a new (Conditional) one carrying
 * the provenance stamp. Makes are per-material (makes.material_code).
 */
async function ensureMake(
  db: Db,
  materialCode: string,
  brand: BrandRef,
  tier: MakeTier | null,
  provenance: Record<string, unknown>,
): Promise<string> {
  const brandName = brand.normalized ?? brand.raw;
  const forMaterial = await db.select().from(makes).where(eq(makes.materialCode, materialCode));
  const existing = forMaterial.find((m) => m.brandName.toLowerCase() === brandName.toLowerCase());
  if (existing) return existing.makeCode;

  const allCodes = await db.select({ code: makes.makeCode }).from(makes);
  const makeCode = deriveMakeCode(materialCode, brandName, new Set(allCodes.map((r) => r.code)));
  await db.insert(makes).values({
    makeCode,
    materialCode,
    brandName,
    tier: tier ?? DEFAULT_MAKE_TIER,
    approvalStatus: INGESTED_MAKE_APPROVAL,
    notes: null,
    sourceProvenance: provenance,
  });
  return makeCode;
}

/** Map a free-text install unit onto the closed InstallRateUnit enum. */
function toInstallUnit(u: string): InstallRateUnit {
  const norm = u.trim().toLowerCase();
  const map: Record<string, InstallRateUnit> = {
    "per no.": "Per No.",
    "per no": "Per No.",
    "no.": "Per No.",
    no: "Per No.",
    nos: "Per No.",
    each: "Per No.",
    "per metre": "Per Metre",
    "per meter": "Per Metre",
    metre: "Per Metre",
    meter: "Per Metre",
    m: "Per Metre",
    rm: "Per Metre",
    "per rm": "Per Metre",
    "per set": "Per Set",
    set: "Per Set",
    "per floor": "Per Floor",
    floor: "Per Floor",
    lumpsum: "Lumpsum",
    "lump sum": "Lumpsum",
    ls: "Lumpsum",
    lot: "Lumpsum",
  };
  return map[norm] ?? "Lumpsum";
}

function isMaterialCategory(c: string): c is MaterialCategory {
  return (MATERIAL_CATEGORIES as readonly string[]).includes(c);
}

/** Copy the whitelisted locator fields the provenance schema accepts. */
function provenanceLocatorFields(loc: Record<string, unknown> | null): {
  page?: number;
  sheet?: string;
  row?: number;
} {
  const out: { page?: number; sheet?: string; row?: number } = {};
  if (loc) {
    if (typeof loc.page === "number") out.page = loc.page;
    if (typeof loc.sheet === "string") out.sheet = loc.sheet;
    if (typeof loc.row === "number") out.row = loc.row;
  }
  return out;
}

// ─── commitStagedRecord ─────────────────────────────────────────────────────

export type CommitDecision = "APPROVED" | "EDITED_APPROVED" | "MERGED";

export interface CommitStagedRecordArgs {
  stagedRecordId: string;
  reviewer: string;
  decision: CommitDecision;
  edits?: Record<string, unknown>;
  mergeIntoCode?: string;
  nameEmbedding?: number[] | null;
  embeddingModel?: string | null;
}

export interface CommitOutcome {
  kind: TargetMaster;
  materialCode?: string;
  makeCode?: string;
  priceId?: string;
  installRateId?: string;
  degraded: boolean;
}

export interface CommitResult {
  stagedRecordId: string;
  decision: CommitDecision;
  outcome: CommitOutcome;
}

/**
 * Commit one reviewed staged_record into the masters in ONE transaction:
 * validate (proposed ⊕ edits), stamp provenance, run the dedup re-check
 * (trigram ≥ 0.82 or an explicit MERGE degrades a new-material bundle to a
 * price-point on the matched code), write the target master rows with
 * provenance, optionally upsert the material-name embedding, flip the staged
 * row's status, and append the STAGED_COMMITTED audit event. Any failure rolls
 * the whole thing back.
 */
export async function commitStagedRecord(
  db: Db,
  args: CommitStagedRecordArgs,
): Promise<CommitResult> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;

    // 1. Load staged row + run + document.
    const stagedRows = await tx
      .select()
      .from(stagedRecords)
      .where(eq(stagedRecords.id, args.stagedRecordId))
      .limit(1);
    const staged = stagedRows[0];
    if (!staged) throw new Error(`staged record ${args.stagedRecordId} not found`);
    if (staged.status !== "PROPOSED")
      throw new Error(`staged record ${args.stagedRecordId} already reviewed (${staged.status})`);

    const runRows = await tx
      .select()
      .from(extractionRuns)
      .where(eq(extractionRuns.id, staged.extractionRunId))
      .limit(1);
    const run = runRows[0];
    if (!run) throw new Error(`extraction run ${staged.extractionRunId} not found`);

    const docRows = await tx
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, run.sourceDocumentId))
      .limit(1);
    const doc = docRows[0];
    if (!doc) throw new Error(`source document ${run.sourceDocumentId} not found`);

    const targetMaster = staged.targetMaster as TargetMaster;

    // 2. Merge edits over proposed, validate.
    const merged = { ...staged.proposed, ...(args.edits ?? {}) };
    const parsed = stagedPayloadSchemaFor(targetMaster).parse(merged);

    // 3. Build + validate provenance.
    const now = new Date();
    const provenance = sourceProvenanceSchema.parse({
      sourceDocumentId: doc.id,
      extractionRunId: run.id,
      stagedRecordId: staged.id,
      filename: doc.filename,
      ...provenanceLocatorFields(staged.sourceLocator),
      promptVersion: run.promptVersion,
      committedBy: args.reviewer,
      committedAt: now.toISOString(),
    }) as unknown as Record<string, unknown>;

    let outcome: CommitOutcome;
    let degradedTo: string | undefined;

    if (targetMaster === "materials") {
      const bundle = parsed as StagedMaterialBundle;

      // 4. Dedup re-check / explicit merge.
      let matchedCode: string | null = null;
      if (args.decision === "MERGED") {
        if (!args.mergeIntoCode) throw new Error("MERGED decision requires mergeIntoCode");
        await assertMaterialExists(tx, args.mergeIntoCode);
        matchedCode = args.mergeIntoCode;
      } else {
        const candidates = await trgmMaterialCandidates(tx, bundle.material.materialName, 5);
        const top = candidates[0];
        if (top && top.similarity >= DEDUP_SIMILARITY_THRESHOLD) matchedCode = top.materialCode;
      }

      if (matchedCode) {
        // Degrade: commit as a price-point (+make link) on the matched material.
        degradedTo = matchedCode;
        const makeCode = await ensureMake(
          tx,
          matchedCode,
          bundle.make.brandName,
          bundle.make.tier ?? null,
          provenance,
        );
        let priceId: string | undefined;
        if (bundle.price.sellRupees !== null) {
          priceId = await insertHistoricalPrice(tx, {
            materialCode: matchedCode,
            makeCode,
            sellPaise: toPaise(bundle.price.sellRupees),
            buyPaise: bundle.price.buyRupees != null ? toPaise(bundle.price.buyRupees) : null,
            validFrom: bundle.price.validFromISO ? new Date(bundle.price.validFromISO) : now,
            createdBy: args.reviewer,
            sourceProvenance: provenance,
          });
        }
        if (args.nameEmbedding) {
          await upsertMaterialNameEmbedding(
            tx,
            matchedCode,
            args.nameEmbedding,
            args.embeddingModel ?? "unknown",
          );
        }
        outcome = { kind: "prices", materialCode: matchedCode, makeCode, priceId, degraded: true };
      } else {
        // 5a. Fresh material bundle.
        const category = bundle.material.category;
        if (!isMaterialCategory(category))
          throw new Error(`commit: "${category}" is not a valid material category`);

        const existingRows = await tx.select({ code: materials.materialCode }).from(materials);
        const existingCodes = new Set(existingRows.map((r) => r.code));
        let materialCode = bundle.material.materialCode;
        if (existingCodes.has(materialCode)) {
          materialCode = proposeMaterialCode(bundle.material.systemType, category, existingCodes);
        }

        await insertMaterial(tx, {
          materialCode,
          materialName: bundle.material.materialName,
          systemType: bundle.material.systemType,
          category,
          unitOfMeasure: bundle.material.unitOfMeasure.normalized ?? DEFAULT_UNIT_OF_MEASURE,
          active: true,
          sourceProvenance: provenance,
        });

        if (bundle.material.specSummary) {
          await insertMaterialSpec(tx, {
            materialCode,
            applicableStandard: null,
            rating: null,
            size: null,
            certifications: [],
            complianceNotes: bundle.material.specSummary,
          });
        }

        const makeCode = await ensureMake(
          tx,
          materialCode,
          bundle.make.brandName,
          bundle.make.tier ?? null,
          provenance,
        );

        let priceId: string | undefined;
        if (bundle.price.sellRupees !== null) {
          priceId = await insertHistoricalPrice(tx, {
            materialCode,
            makeCode,
            sellPaise: toPaise(bundle.price.sellRupees),
            buyPaise: bundle.price.buyRupees != null ? toPaise(bundle.price.buyRupees) : null,
            validFrom: bundle.price.validFromISO ? new Date(bundle.price.validFromISO) : now,
            createdBy: args.reviewer,
            sourceProvenance: provenance,
          });
        }

        let installRateId: string | undefined;
        if (bundle.installRate) {
          installRateId = await insertHistoricalInstallRate(tx, {
            rateCode: `INST-${materialCode}`,
            description: `Installation, testing & commissioning — ${bundle.material.materialName}`,
            systemType: bundle.material.systemType,
            linkedMaterialCode: materialCode,
            ratePaise: toPaise(bundle.installRate.rupees),
            unit: toInstallUnit(bundle.installRate.unit),
            validFrom: now,
            sourceProvenance: provenance,
          });
        }

        if (args.nameEmbedding) {
          await upsertMaterialNameEmbedding(
            tx,
            materialCode,
            args.nameEmbedding,
            args.embeddingModel ?? "unknown",
          );
        }

        outcome = {
          kind: "materials",
          materialCode,
          makeCode,
          priceId,
          installRateId,
          degraded: false,
        };
      }
    } else if (targetMaster === "prices") {
      const pp = parsed as StagedPricePoint;
      await assertMaterialExists(tx, pp.materialCode);
      const makeCode = await ensureMake(tx, pp.materialCode, pp.brandName, null, provenance);
      const priceId = await insertHistoricalPrice(tx, {
        materialCode: pp.materialCode,
        makeCode,
        sellPaise: toPaise(pp.sellRupees),
        buyPaise: pp.buyRupees != null ? toPaise(pp.buyRupees) : null,
        validFrom: pp.validFromISO ? new Date(pp.validFromISO) : now,
        createdBy: args.reviewer,
        sourceProvenance: provenance,
      });
      outcome = { kind: "prices", materialCode: pp.materialCode, makeCode, priceId, degraded: false };
    } else if (targetMaster === "makes") {
      const ml = parsed as StagedMakeLink;
      await assertMaterialExists(tx, ml.materialCode);
      const makeCode = await ensureMake(tx, ml.materialCode, ml.brandName, ml.tier ?? null, provenance);
      outcome = { kind: "makes", materialCode: ml.materialCode, makeCode, degraded: false };
    } else {
      const ir = parsed as StagedInstallRate;
      const linked = ir.materialCode ?? null;
      if (linked) await assertMaterialExists(tx, linked);
      const rateCode = linked ? `INST-${linked}` : `INST-${ir.systemType}-${newUlid().slice(-8)}`;
      const installRateId = await insertHistoricalInstallRate(tx, {
        rateCode,
        description: `Installation rate — ${ir.systemType}`,
        systemType: ir.systemType,
        linkedMaterialCode: linked,
        ratePaise: toPaise(ir.rupees),
        unit: toInstallUnit(ir.unit),
        validFrom: now,
        sourceProvenance: provenance,
      });
      outcome = {
        kind: "install_rates",
        materialCode: linked ?? undefined,
        installRateId,
        degraded: false,
      };
    }

    // 8. Advance the staged row.
    const newStatus: StagedRecordStatus = args.decision;
    await tx
      .update(stagedRecords)
      .set({ status: newStatus, reviewedBy: args.reviewer, reviewedAt: now })
      .where(eq(stagedRecords.id, staged.id));

    // 9. Audit — same transaction (STAGED_COMMITTED carries null estimate/enquiry).
    await appendAudit(tx, {
      eventType: "STAGED_COMMITTED",
      actor: args.reviewer,
      payload: {
        stagedRecordId: staged.id,
        targetMaster,
        decision: args.decision,
        sourceDocumentId: doc.id,
        extractionRunId: run.id,
        editedFields: Object.keys(args.edits ?? {}),
        ...(outcome.materialCode ? { materialCode: outcome.materialCode } : {}),
        ...(outcome.makeCode ? { makeCode: outcome.makeCode } : {}),
        ...(outcome.priceId ? { priceId: outcome.priceId } : {}),
        ...(outcome.installRateId ? { installRateId: outcome.installRateId } : {}),
        ...(degradedTo ? { degradedTo } : {}),
      },
    });

    return { stagedRecordId: staged.id, decision: args.decision, outcome };
  });
}
