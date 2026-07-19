import {
  PDF_EXTRACT_PROMPT_VERSION,
  estimateCostUsd,
  extractDocMeta,
  extractPageWindow,
  providerForModel,
  type DocMeta,
  type Embedder,
  type LanguageModel,
} from "@pebble/ai";
import type { Db, DocChunkInput, NewStagedRecord, SourceDocumentRow } from "@pebble/db";
import {
  deleteProposedForDocument,
  finishExtractionRun,
  getSourceDocument,
  getSourceDocumentByUri,
  insertStagedRecords,
  listMaterials,
  registerSourceDocument,
  replaceDocChunks,
  setSourceDocumentStatus,
  startExtractionRun,
} from "@pebble/db";
import {
  paiseToRupees,
  proposeMaterialCode,
  toPaise,
  type SourceDocStatus,
  type StagedMakeLink,
  type StagedMaterialBundle,
  type StagedPricePoint,
  type SystemType,
} from "@pebble/shared";
import pLimit from "p-limit";
import { WorkerError } from "../errors";
import type { StorageAdapter } from "../storage";
import { buildChunks, type BuildChunksArgs, type ChunkDocMeta } from "./chunks";
import { classifyLineTarget, materialishName, type LineTargetResult } from "./dedup";
import { parseCorpusFilename, sourceEntityForDate } from "./filename";
import { normalizeLine, type NormalizedLine } from "./normalize";
import { pdfPageCount, splitPdfWindows } from "./pdf-window";
import type { RawLine } from "./types";
import { parseXlsxWorkbook } from "./xlsx";

/**
 * The Phase B per-document ingestion orchestrator (PLAN §4.5 steps 1–7) — the
 * seam that turns a registered source file into staged master proposals + RAG
 * chunks. It is deliberately a RESUMABLE STATUS MACHINE
 * (REGISTERED → META_DONE → LINES_DONE → STAGED → DONE): each stage persists its
 * own output (meta.json / lines.json in `ingest-work/`, chunks and staged rows in
 * the db) BEFORE advancing the document's status, so a crashed run — replayed by
 * a Cloud Tasks retry — picks up from the last completed stage instead of
 * re-doing (and re-paying for) the model calls. A FAILED document is resumed by
 * probing which artifacts already exist rather than trusting the status alone.
 *
 * The two extraction lanes converge here: PDFs go through Gemini (whole-doc meta
 * pass → page-windowed line pass), XLSX go through the deterministic exceljs
 * parser (no model). From LINES_DONE on, both lanes are identical, model-free and
 * pure-replayable: normalize → dedup-route → stage → chunk.
 */

const XLSX_INGEST_VERSION = "xlsx-deterministic-v1";
const XLSX_RUN_MODEL = "deterministic-xlsx";
/** Gentle parallelism over page windows — a courtesy to the model's rate limits. */
const WINDOW_CONCURRENCY = 2;

export interface IngestAiDeps {
  /** Gemini model for PDF extraction, or null when no key is configured (XLSX still ingest). */
  model: LanguageModel | null;
  embedder: Embedder;
}

export interface IngestDeps {
  db: Db;
  storage: StorageAdapter;
  ai: IngestAiDeps;
}

export interface IngestArgs {
  /** GCS/file uri of the source document; registered on first sight. */
  sourceUri?: string;
  /** Id of an already-registered source document. */
  sourceDocumentId?: string;
  /** Re-ingest from scratch: drop still-PROPOSED rows + chunks and replay from REGISTERED. */
  force?: boolean;
}

export interface IngestReport {
  sourceDocumentId: string;
  status: SourceDocStatus;
  runId: string | null;
  promptVersion: string;
  pagesProcessed: number;
  linesStaged: number;
  chunksIndexed: number;
  costUsd: number;
  warnings: string[];
}

// ─── Persisted stage artifacts ──────────────────────────────────────────────

interface PersistedMeta {
  meta: DocMeta;
  metaUsage: { inputTokens: number; outputTokens: number };
}
/** Raw lines carry an optional xlsx `locator`; PDFs use the 1-based `page`. */
type PersistedRawLine = RawLine & { locator?: { sheet: string; row: number } };
interface PersistedLines {
  lines: PersistedRawLine[];
  termsText: string | null;
  /**
   * The extraction run these lines were extracted under — persisted so the
   * staging stage can attach its records to the same run even when it runs in a
   * later (resumed) invocation, WITHOUT the worker needing to query the runs
   * table directly (it doesn't depend on drizzle).
   */
  runId: string;
}

const metaKey = (docId: string): string => `ingest-work/${docId}/meta.json`;
const linesKey = (docId: string): string => `ingest-work/${docId}/lines.json`;

async function writeJson(storage: StorageAdapter, key: string, value: unknown): Promise<void> {
  await storage.put(key, Buffer.from(JSON.stringify(value), "utf8"), "application/json");
}
async function readJson<T>(storage: StorageAdapter, key: string): Promise<T> {
  const buf = await storage.get(storage.keyToUri(key));
  return JSON.parse(buf.toString("utf8")) as T;
}
async function tryReadJson<T>(storage: StorageAdapter, key: string): Promise<T | null> {
  try {
    return await readJson<T>(storage, key);
  } catch {
    return null;
  }
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A full ISO-8601 datetime (for staged `validFromISO`) from the best available date. */
function validFromDatetime(date: Date | null, metaISO: string | null): string | null {
  if (date) return date.toISOString();
  if (metaISO) return `${metaISO}T00:00:00.000Z`;
  return null;
}

function safeToPaise(rupees: number): number | null {
  try {
    return toPaise(rupees, "ingest.grandTotal");
  } catch {
    return null;
  }
}

function round3(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;
}

function filenameFromUri(uri: string): string {
  const noQuery = uri.split(/[?#]/)[0] ?? uri;
  const tail = noQuery.split("/").pop() ?? uri;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

function docIsXlsx(filename: string, docType: string): boolean {
  return filename.toLowerCase().endsWith(".xlsx") || docType.toLowerCase() === "xlsx";
}

/**
 * estimateCostUsd falls back to a Claude rate for an unknown model id, which
 * would silently mis-price a Gemini extraction. Only trust it for a genuine
 * gemini model id; otherwise record 0 and warn (matches the "not in the rate
 * table" contract).
 */
function computeCost(modelId: string, inputTokens: number, outputTokens: number, warnings: string[]): number {
  if (providerForModel(modelId) !== "google") {
    warnings.push(`model "${modelId}" is not a known gemini rate — extraction cost recorded as 0`);
    return 0;
  }
  return estimateCostUsd(modelId, inputTokens, outputTokens);
}

// ─── Meta / chunk assembly ──────────────────────────────────────────────────

/** Doc-level chunk metadata: printed values win, filename-derived fallbacks fill gaps. */
function chunkMeta(doc: SourceDocumentRow, meta: DocMeta): ChunkDocMeta {
  return {
    clientName: meta.clientName,
    projectName: meta.projectName,
    docDateISO: meta.docDateISO ?? (doc.docDate ? isoDate(doc.docDate) : null),
    revision: meta.revision ?? doc.revision,
    sourceEntity: meta.sourceEntityGuess ?? doc.sourceEntity,
    docKind: meta.docKind,
    summary: meta.summary,
    systems: meta.systemsMentioned,
    grandTotalPaise: meta.grandTotalRupees !== null ? safeToPaise(meta.grandTotalRupees) : null,
  };
}

function chunkArgs(
  doc: SourceDocumentRow,
  meta: DocMeta,
  lines: NormalizedLine[],
  termsText: string | null,
): BuildChunksArgs {
  return {
    meta: chunkMeta(doc, meta),
    lines,
    termsText,
    fileRef: doc.fileRef,
    filename: doc.filename,
    docType: doc.docType,
  };
}

/** A DocMeta synthesized from the filename for the model-free XLSX lane. */
function synthesizeXlsxMeta(doc: SourceDocumentRow): DocMeta {
  const parsed = parseCorpusFilename(doc.filename);
  return {
    clientName: null,
    projectName: parsed.title.length > 0 ? parsed.title : null,
    attention: null,
    docDateISO: doc.docDate ? isoDate(doc.docDate) : null,
    revision: doc.revision,
    sourceEntityGuess: doc.sourceEntity,
    docKind: "estimate",
    systemsMentioned: [],
    sections: [],
    grandTotalRupees: null,
    gstMentioned: null,
    summary: `Historical fire-safety estimate workbook: ${doc.filename}.`,
  };
}

/** Embed + persist a set of chunk drafts, replacing ALL of the document's chunks. */
async function indexChunks(
  db: Db,
  embedder: Embedder,
  docId: string,
  drafts: ReturnType<typeof buildChunks>,
  warnings: string[],
): Promise<number> {
  let embeddings: Array<number[] | null>;
  try {
    embeddings = await embedder.embed(drafts.map((d) => d.content));
  } catch (err) {
    warnings.push(`embedding failed (${(err as Error).message}) — chunks indexed without vectors`);
    embeddings = drafts.map(() => null);
  }
  const inputs: DocChunkInput[] = drafts.map((d, i) => ({
    chunkKind: d.chunkKind,
    content: d.content,
    embedding: embeddings[i] ?? null,
    metadata: d.metadata,
  }));
  return replaceDocChunks(db, docId, inputs);
}

// ─── Staging ────────────────────────────────────────────────────────────────

/** {page} for a PDF line, {sheet,row} for an xlsx line, {slNo} as a last resort. */
function sourceLocatorFor(raw: PersistedRawLine): Record<string, unknown> {
  if (raw.locator) return { sheet: raw.locator.sheet, row: raw.locator.row };
  if (raw.page > 0) return { page: raw.page };
  return raw.slNo ? { slNo: raw.slNo } : {};
}

interface StageContext {
  existingCodes: Set<string>;
  validFromISO: string | null;
}

/** Turn one normalized line + its dedup routing into a staged-record payload. */
function buildStagedRecord(
  norm: NormalizedLine,
  raw: PersistedRawLine,
  target: LineTargetResult,
  ctx: StageContext,
): NewStagedRecord {
  const sourceLocator = sourceLocatorFor(raw);
  const brandName = {
    raw: norm.brand.raw && norm.brand.raw.trim().length > 0 ? norm.brand.raw : "Unspecified",
    normalized: norm.brand.normalized,
  };
  const sellRupees = norm.sellPaise !== null ? paiseToRupees(norm.sellPaise) : null;
  const sourceText = norm.description.trim();
  const confidence = round3(norm.confidence);

  if (target.targetMaster === "prices" && target.dedupCandidateCode) {
    if (sellRupees !== null) {
      const proposed: StagedPricePoint = {
        payloadVersion: 1,
        materialCode: target.dedupCandidateCode,
        brandName,
        sellRupees,
        rateKind: norm.rateKind,
        validFromISO: ctx.validFromISO,
        sourceText,
      };
      return { targetMaster: "prices", proposed, confidence, dedupCandidateCode: target.dedupCandidateCode, sourceLocator };
    }
    // Strong material match but no rate on the line → link the make, no price.
    const proposed: StagedMakeLink = {
      payloadVersion: 1,
      materialCode: target.dedupCandidateCode,
      brandName,
      sourceText,
    };
    return { targetMaster: "makes", proposed, confidence, dedupCandidateCode: target.dedupCandidateCode, sourceLocator };
  }

  // A NEW material bundle (possibly carrying a reviewer-merge candidate).
  const systemType: SystemType = norm.systemGuess ?? "Common";
  const category = norm.categoryGuess ?? "Accessory";
  const materialCode = proposeMaterialCode(systemType, category, ctx.existingCodes);
  ctx.existingCodes.add(materialCode); // so a second new proposal keeps incrementing
  // The shared schema requires a non-empty raw unit; "unspecified" (normalized
  // null) keeps the "document was silent" fact visible to the reviewer rather
  // than dressing a default up as a printed value.
  const unitRaw = norm.unit.raw && norm.unit.raw.trim().length > 0 ? norm.unit.raw : "unspecified";
  const proposed: StagedMaterialBundle = {
    payloadVersion: 1,
    material: {
      materialCode,
      materialName: materialishName(norm),
      systemType,
      category,
      unitOfMeasure: { raw: unitRaw, normalized: norm.unit.normalized },
    },
    make: { brandName },
    price: { sellRupees, rateKind: norm.rateKind, validFromISO: ctx.validFromISO },
    sourceText,
  };
  return { targetMaster: "materials", proposed, confidence, dedupCandidateCode: target.dedupCandidateCode, sourceLocator };
}

// ─── Document resolution ─────────────────────────────────────────────────────

async function resolveDocument(deps: IngestDeps, args: IngestArgs): Promise<SourceDocumentRow> {
  const { db, storage } = deps;
  if (args.sourceDocumentId) {
    const doc = await getSourceDocument(db, args.sourceDocumentId);
    if (!doc) throw new WorkerError(`source document ${args.sourceDocumentId} not found`, 404);
    return doc;
  }
  const uri = args.sourceUri;
  if (!uri) throw new WorkerError("sourceUri or sourceDocumentId is required", 400);

  const existing = await getSourceDocumentByUri(db, uri);
  if (existing) return existing;

  const filename = filenameFromUri(uri);
  const parsed = parseCorpusFilename(filename);
  let pageCount: number | null = null;
  if (!docIsXlsx(filename, parsed.docType)) {
    pageCount = await pdfPageCount(await storage.get(uri));
  }
  const { id } = await registerSourceDocument(db, {
    filename,
    storageUri: uri,
    docType: parsed.docType,
    fileRef: parsed.fileRef,
    revision: parsed.revision,
    docDate: parsed.docDate,
    sourceEntity: sourceEntityForDate(parsed.docDate),
    pageCount,
  });
  const doc = await getSourceDocument(db, id);
  if (!doc) throw new WorkerError(`failed to register source document for ${uri}`, 500);
  return doc;
}

/** For a FAILED doc, re-derive the resume point from which artifacts survived. */
async function resolveResumeStatus(storage: StorageAdapter, doc: SourceDocumentRow): Promise<SourceDocStatus> {
  if (doc.status !== "FAILED") return doc.status;
  if (!(await tryReadJson<PersistedMeta>(storage, metaKey(doc.id)))) return "REGISTERED";
  if (!(await tryReadJson<PersistedLines>(storage, linesKey(doc.id)))) return "META_DONE";
  return "LINES_DONE"; // staging (delete-then-insert) + chunking (replace) are idempotent
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export async function ingestSourceDocument(deps: IngestDeps, args: IngestArgs): Promise<IngestReport> {
  const { db, storage, ai } = deps;
  const doc = await resolveDocument(deps, args);
  const docId = doc.id;
  const isXlsx = docIsXlsx(doc.filename, doc.docType);
  const promptVersion = isXlsx ? XLSX_INGEST_VERSION : PDF_EXTRACT_PROMPT_VERSION;

  const warnings: string[] = [];
  let runId: string | null = null;
  let runOpen = false;
  let costUsd = 0;
  let pagesProcessed = 0;
  let linesStaged = 0;
  let chunksIndexed = 0;

  const force = args.force === true;
  let effective: SourceDocStatus;
  if (force) {
    await deleteProposedForDocument(db, docId);
    await replaceDocChunks(db, docId, []);
    await setSourceDocumentStatus(db, docId, "REGISTERED");
    effective = "REGISTERED";
  } else if (doc.status === "DONE") {
    // Idempotent short-circuit: a completed document, no force → zero work.
    // The run id is recovered from the persisted lines.json (best-effort).
    const persisted = await tryReadJson<PersistedLines>(storage, linesKey(docId));
    return {
      sourceDocumentId: docId,
      status: "DONE",
      runId: persisted?.runId ?? null,
      promptVersion,
      pagesProcessed: 0,
      linesStaged: 0,
      chunksIndexed: 0,
      costUsd: 0,
      warnings,
    };
  } else {
    effective = await resolveResumeStatus(storage, doc);
  }

  // Source bytes + persisted artifacts, loaded once per invocation on demand.
  let sourceBytes: Buffer | null = null;
  const getBytes = async (): Promise<Buffer> => (sourceBytes ??= await storage.get(doc.storageUri));
  let metaWrap: PersistedMeta | null = null;
  const loadMeta = async (): Promise<PersistedMeta> => (metaWrap ??= await readJson<PersistedMeta>(storage, metaKey(docId)));
  let linesWrap: PersistedLines | null = null;
  const loadLines = async (): Promise<PersistedLines> => (linesWrap ??= await readJson<PersistedLines>(storage, linesKey(docId)));

  try {
    // ── REGISTERED → META_DONE (whole-document metadata + doc_summary chunk) ──
    if (effective === "REGISTERED") {
      if (isXlsx) {
        metaWrap = { meta: synthesizeXlsxMeta(doc), metaUsage: { inputTokens: 0, outputTokens: 0 } };
      } else {
        if (ai.model === null) throw new WorkerError("extraction model not configured", 503);
        runId = await startExtractionRun(db, {
          sourceDocumentId: docId,
          model: modelIdOf(ai.model),
          promptVersion: PDF_EXTRACT_PROMPT_VERSION,
        });
        runOpen = true;
        const { meta, usage } = await extractDocMeta({
          model: ai.model,
          pdfBytes: await getBytes(),
          hints: {
            filename: doc.filename,
            parsedFileRef: doc.fileRef,
            parsedDateISO: doc.docDate ? isoDate(doc.docDate) : null,
            parsedRevision: doc.revision,
          },
        });
        metaWrap = { meta, metaUsage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } };
      }
      await writeJson(storage, metaKey(docId), metaWrap);
      // Index the doc_summary chunk now (empty lines → the single doc_summary draft).
      chunksIndexed = await indexChunks(
        db,
        ai.embedder,
        docId,
        buildChunks(chunkArgs(doc, metaWrap.meta, [], null)),
        warnings,
      );
      await setSourceDocumentStatus(db, docId, "META_DONE");
      effective = "META_DONE";
    }

    // ── META_DONE → LINES_DONE (line extraction) ─────────────────────────────
    if (effective === "META_DONE") {
      const { meta, metaUsage } = await loadMeta();
      if (isXlsx) {
        // No prior-run recovery needed: on a resumed invocation runId is null
        // and a fresh run is started (a hard-crashed RUNNING run, if any, is
        // simply superseded — its FAILED close-out happens in the catch below
        // whenever the crash was catchable).
        runId =
          runId ??
          (await startExtractionRun(db, {
            sourceDocumentId: docId,
            model: XLSX_RUN_MODEL,
            promptVersion: XLSX_INGEST_VERSION,
          }));
        runOpen = true;
        const parsed = await parseXlsxWorkbook(await getBytes());
        for (const w of parsed.warnings) warnings.push(w);
        linesWrap = { lines: parsed.lines, termsText: null, runId };
        costUsd = 0;
      } else {
        if (ai.model === null) throw new WorkerError("extraction model not configured", 503);
        const model = ai.model;
        runId =
          runId ??
          (await startExtractionRun(db, {
            sourceDocumentId: docId,
            model: modelIdOf(model),
            promptVersion: PDF_EXTRACT_PROMPT_VERSION,
          }));
        runOpen = true;

        const windows = await splitPdfWindows(await getBytes());
        pagesProcessed = windows.length > 0 ? (windows[windows.length - 1]?.pageEnd ?? 0) : 0;
        const sectionContext = meta.sections.map((s) => s.title).filter((t) => t.length > 0);
        const limit = pLimit(WINDOW_CONCURRENCY);
        const results = await Promise.all(
          windows.map((w) =>
            limit(() =>
              extractPageWindow({
                model,
                windowPdfBytes: w.bytes,
                pageStart: w.pageStart,
                pageEnd: w.pageEnd,
                sectionContext,
              }),
            ),
          ),
        );

        // Merge windows in order, deduping overlap by (page, slNo ?? description).
        const seen = new Set<string>();
        const merged: RawLine[] = [];
        const termsParts: string[] = [];
        let inputTokens = metaUsage.inputTokens;
        let outputTokens = metaUsage.outputTokens;
        for (const r of results) {
          inputTokens += r.usage.inputTokens;
          outputTokens += r.usage.outputTokens;
          if (r.termsText && r.termsText.trim().length > 0) termsParts.push(r.termsText.trim());
          for (const line of r.lines) {
            const key = `${line.page}::${line.slNo ?? line.description}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(line);
          }
        }
        linesWrap = { lines: merged, termsText: termsParts.length > 0 ? termsParts.join("\n\n") : null, runId };
        costUsd = computeCost(modelIdOf(model), inputTokens, outputTokens, warnings);
      }
      await writeJson(storage, linesKey(docId), linesWrap);
      await setSourceDocumentStatus(db, docId, "LINES_DONE");
      // The extraction pass is complete — close its run out with the tallied cost.
      if (runId) {
        await finishExtractionRun(db, runId, { status: "SUCCEEDED", costUsd });
        runOpen = false;
      }
      effective = "LINES_DONE";
    }

    // ── LINES_DONE → STAGED (normalize → dedup → stage) ──────────────────────
    if (effective === "LINES_DONE") {
      const { meta } = await loadMeta();
      const { lines, runId: persistedRunId } = await loadLines();
      const stageRunId = runId ?? persistedRunId ?? null;
      if (!stageRunId) throw new WorkerError(`no extraction run to stage records against for ${docId}`, 500);
      runId = stageRunId;

      // Replayable: clear any still-PROPOSED rows from a prior partial staging.
      await deleteProposedForDocument(db, docId);

      const ctx: StageContext = {
        existingCodes: new Set((await listMaterials(db)).map((m) => m.materialCode)),
        validFromISO: validFromDatetime(doc.docDate, meta.docDateISO),
      };
      const records: NewStagedRecord[] = [];
      let skipped = 0;
      for (const raw of lines) {
        const norm = normalizeLine(raw);
        if (!norm.description || norm.description.trim().length === 0) {
          skipped++;
          continue;
        }
        if (norm.sellPaise === null && norm.qty === null) {
          skipped++;
          continue;
        }
        const target = await classifyLineTarget(db, norm, { embedder: ai.embedder });
        records.push(buildStagedRecord(norm, raw, target, ctx));
      }
      if (skipped > 0) {
        warnings.push(`${skipped} line(s) skipped (no description, or missing both rate and qty)`);
      }
      linesStaged = await insertStagedRecords(db, stageRunId, records);
      await setSourceDocumentStatus(db, docId, "STAGED");
      effective = "STAGED";
    }

    // ── STAGED → DONE (rebuild the full chunk set incl. doc_summary) ──────────
    if (effective === "STAGED") {
      const { meta } = await loadMeta();
      const { lines, termsText } = await loadLines();
      const normalized = lines.map((l) => normalizeLine(l));
      chunksIndexed = await indexChunks(
        db,
        ai.embedder,
        docId,
        buildChunks(chunkArgs(doc, meta, normalized, termsText)),
        warnings,
      );
      await setSourceDocumentStatus(db, docId, "DONE");
      effective = "DONE";
    }
  } catch (err) {
    if (runId && runOpen) {
      try {
        await finishExtractionRun(db, runId, { status: "FAILED", costUsd });
      } catch {
        /* best-effort — the primary error is what matters */
      }
    }
    try {
      await setSourceDocumentStatus(db, docId, "FAILED");
    } catch {
      /* best-effort */
    }
    if (err instanceof WorkerError) throw err;
    throw new WorkerError((err as Error)?.message ?? "ingestion failed", 500);
  }

  return {
    sourceDocumentId: docId,
    status: effective,
    runId,
    promptVersion,
    pagesProcessed,
    linesStaged,
    chunksIndexed,
    costUsd,
    warnings,
  };
}
