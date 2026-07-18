/**
 * `@pebble/worker` — the Hono service that renders Format A documents and fans
 * dispatches out to email + WhatsApp (PLAN §4.5–4.7).
 *
 * This barrel exports the app factory, the pure task handlers, and the
 * storage/PDF abstractions so they can be reused and unit-tested (e.g. the web
 * app can call `renderEstimateDocuments` directly, or a test can build an app
 * with a `StubPdfRenderer` + `LocalStorageAdapter`). `server.ts` is the runtime
 * entrypoint and is intentionally NOT re-exported (it has boot side effects).
 */

// App factory + deps type.
export { createApp } from "./app";
export type { AppDeps } from "./app";

// Task handlers.
export { renderEstimateDocuments } from "./render";
export type { RenderArgs, RenderDeps, RenderResult, RenderedDoc } from "./render";
export { dispatchEstimateDocuments } from "./dispatch-handler";
export type { DispatchArgs, DispatchDeps } from "./dispatch-handler";
export { ingestDocument } from "./ingest";
export type { IngestArgs, IngestResult } from "./ingest";

// Storage abstraction + factory.
export { createStorage, LocalStorageAdapter, GcsStorageAdapter } from "./storage";
export type { StorageAdapter, PutResult } from "./storage";

// PDF abstraction + factory.
export { createPdfRenderer, PlaywrightPdfRenderer, StubPdfRenderer } from "./pdf";
export type { HtmlToPdf, PlaywrightPdfOptions } from "./pdf";

// Shared error type.
export { WorkerError } from "./errors";
