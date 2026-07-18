/**
 * Ingestion task — STUB.
 *
 * Ingestion (extraction + RAG over the ~145 historical BOQ PDFs/XLSX) is a
 * later phase (PLAN §4.5). It is a resumable, per-document Cloud Tasks pipeline:
 * register file in GCS → whole-doc metadata pass (→ doc_summary RAG chunk) →
 * page-windowed line extraction (Gemini Flash multimodal for PDFs, deterministic
 * exceljs for XLSX) → pure-code normalization → dedup (pg_trgm + embeddings) →
 * human verification queue → masters. None of that exists yet.
 *
 * This endpoint is wired now so the worker's task surface is complete and the
 * Cloud Tasks queue can be created ahead of the implementation; it simply
 * reports that the work is not implemented.
 *
 * TODO(PLAN §4.5): implement the ingestion pipeline steps 1–7.
 */

export interface IngestArgs {
  /** GCS uri (or local path) of the source document to ingest. */
  sourceUri?: string;
  /** Parsed source-document id, when the file is already registered. */
  sourceDocumentId?: string;
  /** Arbitrary passthrough for the future pipeline; ignored for now. */
  [key: string]: unknown;
}

export interface IngestResult {
  status: "not_implemented";
}

export async function ingestDocument(_args: IngestArgs): Promise<IngestResult> {
  // Intentionally a no-op until PLAN §4.5 lands.
  return { status: "not_implemented" };
}
