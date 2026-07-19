import { WorkerError } from "./errors";
import { ingestSourceDocument } from "./ingest/pipeline";
import type { IngestArgs, IngestDeps, IngestReport } from "./ingest/pipeline";

/**
 * The `/tasks/ingest` task handler — the thin validation + delegation layer over
 * the resumable pipeline (`ingest/pipeline.ts`). It parses/validates the request
 * body into `IngestArgs`, then hands off to `ingestSourceDocument`; all the real
 * work (registration, extraction, staging, chunking, resume) lives in the
 * pipeline so it stays unit-testable without the HTTP surface.
 */

export type { IngestArgs, IngestDeps, IngestReport } from "./ingest/pipeline";
export type { IngestAiDeps } from "./ingest/pipeline";
export { ingestSourceDocument } from "./ingest/pipeline";

/** Validate a raw request body into `IngestArgs` (at least one of uri/id required). */
export function parseIngestArgs(body: Record<string, unknown>): IngestArgs {
  const sourceUri = typeof body.sourceUri === "string" && body.sourceUri.length > 0 ? body.sourceUri : undefined;
  const sourceDocumentId =
    typeof body.sourceDocumentId === "string" && body.sourceDocumentId.length > 0
      ? body.sourceDocumentId
      : undefined;
  if (sourceUri === undefined && sourceDocumentId === undefined) {
    throw new WorkerError("at least one of sourceUri / sourceDocumentId is required", 400);
  }
  return { sourceUri, sourceDocumentId, force: body.force === true };
}

/** Parse + delegate: the whole `/tasks/ingest` request lifecycle. */
export async function ingestDocument(deps: IngestDeps, body: Record<string, unknown>): Promise<IngestReport> {
  return ingestSourceDocument(deps, parseIngestArgs(body));
}
