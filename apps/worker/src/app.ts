import type { Db } from "@pebble/db";
import type { DispatchProviders } from "@pebble/dispatch";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { dispatchEstimateDocuments } from "./dispatch-handler";
import type { DispatchArgs } from "./dispatch-handler";
import { WorkerError } from "./errors";
import { ingestDocument } from "./ingest";
import type { HtmlToPdf } from "./pdf";
import { renderEstimateDocuments } from "./render";
import type { RenderArgs } from "./render";
import type { StorageAdapter } from "./storage";

/**
 * The worker HTTP surface — a thin Hono adapter over the pure task handlers.
 *
 * Dependencies (db handle, storage, pdf renderer, dispatch providers) are
 * *injected* rather than built here, so the same routes run against an
 * in-memory PGlite + stub renderer in tests and against Cloud SQL + Chromium in
 * production. Each route validates minimally, delegates to a handler, and maps
 * `WorkerError` to its carried status (everything else → 500).
 */

export interface AppDeps {
  db: Db;
  storage: StorageAdapter;
  pdf: HtmlToPdf;
  providers: DispatchProviders;
}

/** Translate a thrown error into a JSON body + status. */
function errorResponse(err: unknown): { body: { error: string }; status: ContentfulStatusCode } {
  if (err instanceof WorkerError) {
    return { body: { error: err.message }, status: err.status as ContentfulStatusCode };
  }
  // Unexpected — log and surface a generic 500 (details still returned to the
  // caller since this is an internal task API, not a public endpoint).
  console.error("[worker] unhandled task error:", err);
  const message = err instanceof Error ? err.message : String(err);
  return { body: { error: message }, status: 500 };
}

/** Parse a JSON body, mapping malformed JSON to a 400 `WorkerError`. */
async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    if (parsed === null || typeof parsed !== "object") {
      throw new WorkerError("Request body must be a JSON object", 400);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof WorkerError) throw err;
    throw new WorkerError("Invalid JSON body", 400);
  }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  /** Liveness probe (Cloud Run health check). */
  app.get("/health", (c) => c.json({ ok: true }));

  /** Render Format A PDF + XLSX for a (LOCKED) estimate version. */
  app.post("/tasks/render", async (c) => {
    try {
      const body = await readJsonBody(c);
      const estimateId = body.estimateId;
      if (typeof estimateId !== "string" || estimateId.length === 0) {
        throw new WorkerError("estimateId is required", 400);
      }
      const args: RenderArgs = {
        estimateId,
        versionNo: typeof body.versionNo === "number" ? body.versionNo : undefined,
        revision: typeof body.revision === "string" ? body.revision : undefined,
        dateISO: typeof body.dateISO === "string" ? body.dateISO : undefined,
        actor: typeof body.actor === "string" ? body.actor : undefined,
      };
      const result = await renderEstimateDocuments(deps, args);
      return c.json(result);
    } catch (err) {
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  });

  /** Fan a dispatch out to email + WhatsApp and record the outbox rows. */
  app.post("/tasks/dispatch", async (c) => {
    try {
      const body = await readJsonBody(c);
      const estimateId = body.estimateId;
      if (typeof estimateId !== "string" || estimateId.length === 0) {
        throw new WorkerError("estimateId is required", 400);
      }
      if (typeof body.subject !== "string" || typeof body.message !== "string") {
        throw new WorkerError("subject and message are required", 400);
      }
      if (body.toEmail === undefined && body.toPhone === undefined) {
        throw new WorkerError("at least one of toEmail / toPhone is required", 400);
      }
      const args: DispatchArgs = {
        estimateId,
        subject: body.subject,
        message: body.message,
        toEmail: body.toEmail as string | string[] | undefined,
        toPhone: typeof body.toPhone === "string" ? body.toPhone : undefined,
        html: typeof body.html === "string" ? body.html : undefined,
        attachments: body.attachments as DispatchArgs["attachments"],
        documentIds: Array.isArray(body.documentIds)
          ? (body.documentIds as string[])
          : undefined,
        actor: typeof body.actor === "string" ? body.actor : undefined,
      };
      const results = await dispatchEstimateDocuments(deps, args);
      return c.json({ results });
    } catch (err) {
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  });

  /** Ingestion task — stub until PLAN §4.5 lands (see ingest.ts). */
  app.post("/tasks/ingest", async (c) => {
    try {
      const body = await readJsonBody(c);
      const result = await ingestDocument(body);
      return c.json(result);
    } catch (err) {
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  });

  return app;
}
