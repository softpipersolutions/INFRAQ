import "server-only";

import { createEmbedder, createIngestModelFromEnv } from "@pebble/ai";
import type { Db } from "@pebble/db";
import { createEmailProvider, createWhatsAppProvider } from "@pebble/dispatch";
import type { ChannelDispatchResult, DispatchAttachment } from "@pebble/dispatch";
import {
  createPdfRenderer,
  createStorage,
  dispatchEstimateDocuments,
  ingestSourceDocument,
  renderEstimateDocuments,
  WorkerError,
} from "@pebble/worker";
import type { IngestReport, RenderResult } from "@pebble/worker";

/**
 * The web app's single seam to the render/dispatch worker (PLAN §4.6–4.7).
 *
 * Local dev reality: web and worker are separate processes, but PGlite is a
 * single-process embedded database (file lock), so a local worker CANNOT share
 * the web app's data directory. Instead of HTTP, dev calls the worker's *pure
 * task handlers* in-process, reusing the web's own db handle plus env-selected
 * storage/PDF/dispatch factories — the exact same code the worker service runs,
 * minus the transport.
 *
 * Production (Cloud Run + Cloud SQL) sets WORKER_URL, which switches to real
 * HTTP against the worker service, authenticated with an OIDC identity token
 * minted for the WORKER_URL audience (the Cloud Run service-to-service
 * contract). Both paths implement one `WorkerClient` interface so the tRPC
 * routers have a single call-site and no transport awareness.
 *
 * Failure contract: both implementations throw `WorkerError` (message + HTTP
 * status) for expected failures — e.g. the 400 "only LOCKED versions can be
 * rendered" guard — so the router can map them onto typed TRPC errors.
 */

export interface WorkerRenderRequest {
  estimateId: string;
  /** Defaults to the estimate's current version (worker-side). */
  versionNo?: number;
  /** Audit actor recorded on generated_documents + OUTPUT_GENERATED. */
  actor?: string;
}

export interface WorkerDispatchRequest {
  estimateId: string;
  /** Email recipient. Omit to skip the email channel. */
  toEmail?: string;
  /** WhatsApp recipient MSISDN. Omit to skip the WhatsApp channel. */
  toPhone?: string;
  subject: string;
  message: string;
  /** Shared rendered artifacts (PDF / XLSX) referenced by both channels. */
  attachments?: DispatchAttachment[];
  /** generated_documents ids recorded on the outbox rows (provenance). */
  documentIds?: string[];
  /** Audit / outbox actor. */
  actor?: string;
}

export interface WorkerIngestRequest {
  sourceUri?: string;
  sourceDocumentId?: string;
  /** Drop still-PROPOSED staged rows + chunks and replay from scratch. */
  force?: boolean;
}

export interface WorkerClient {
  render(args: WorkerRenderRequest): Promise<RenderResult>;
  dispatch(args: WorkerDispatchRequest): Promise<ChannelDispatchResult[]>;
  ingest(args: WorkerIngestRequest): Promise<IngestReport>;
}

/**
 * Dev/default client: runs the worker's task handlers inside the web process.
 *
 * Constructed per call-site with the caller's db handle (the web's PGlite/pg
 * singleton via tRPC ctx) so the single-process PGlite constraint is respected.
 * Storage, PDF renderer and dispatch providers come from the same env-driven
 * factories the worker service boots with: LocalStorageAdapter under
 * LOCAL_STORAGE_DIR (default .data/outputs), StubPdfRenderer unless
 * RENDER_PDF=1 / PLAYWRIGHT_CHROMIUM_EXECUTABLE, stub email/WhatsApp unless
 * provider credentials are set.
 */
export class InProcessWorkerClient implements WorkerClient {
  readonly kind = "in-process";
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async render(args: WorkerRenderRequest): Promise<RenderResult> {
    return renderEstimateDocuments(
      {
        db: this.db,
        storage: createStorage(process.env),
        pdf: createPdfRenderer(process.env),
      },
      args,
    );
  }

  async dispatch(args: WorkerDispatchRequest): Promise<ChannelDispatchResult[]> {
    return dispatchEstimateDocuments(
      {
        db: this.db,
        providers: {
          email: createEmailProvider(process.env),
          whatsapp: createWhatsAppProvider(process.env),
        },
      },
      args,
    );
  }

  async ingest(args: WorkerIngestRequest): Promise<IngestReport> {
    // Same env-driven deps the worker service boots with: local (or GCS)
    // storage, Gemini model only when a key is configured (XLSX still works
    // without one), stub embedder unless a key + non-stub selection.
    return ingestSourceDocument(
      {
        db: this.db,
        storage: createStorage(process.env),
        ai: {
          model: createIngestModelFromEnv(process.env),
          embedder: createEmbedder(process.env),
        },
      },
      args,
    );
  }
}

/** True when running on GCP (Cloud Run sets K_SERVICE; ADC file counts too). */
function runningOnGcp(): boolean {
  return Boolean(process.env.K_SERVICE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

/**
 * Production client: POSTs task requests to the worker service.
 *
 * On GCP each request carries an OIDC identity token minted for the worker URL
 * audience via google-auth-library (lazy import — never loaded in local dev,
 * where plain fetch suffices against a local worker). Worker 4xx/5xx responses
 * are re-thrown as `WorkerError` carrying the worker's own message and status,
 * so callers see e.g. the LOCKED-only guard verbatim.
 */
export class HttpWorkerClient implements WorkerClient {
  readonly kind = "http";
  private readonly baseUrl: string;

  /** Timeouts per task: rendering may launch Chromium; dispatch is API calls;
   * a document ingest spans multiple model calls over a long PDF. */
  private static readonly RENDER_TIMEOUT_MS = 120_000;
  private static readonly DISPATCH_TIMEOUT_MS = 60_000;
  private static readonly INGEST_TIMEOUT_MS = 900_000;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Authorization header map — OIDC bearer on GCP, empty locally. */
  private async authHeaders(): Promise<Record<string, string>> {
    if (!runningOnGcp()) return {};
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth();
    const client = await auth.getIdTokenClient(this.baseUrl);
    const headers = await client.getRequestHeaders();
    // google-auth-library v10 returns a Headers instance; older versions a
    // plain object. Normalise to the single header we need.
    const bearer =
      headers instanceof Headers
        ? headers.get("authorization")
        : (headers as Record<string, string>)["Authorization"];
    return bearer ? { authorization: bearer } : {};
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await this.authHeaders()) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new WorkerError(`Worker unreachable at ${this.baseUrl}${path}: ${detail}`, 502);
    }

    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      const message =
        payload && typeof payload.error === "string"
          ? payload.error
          : `Worker responded ${res.status} on ${path}`;
      throw new WorkerError(message, res.status);
    }
    return payload as T;
  }

  async render(args: WorkerRenderRequest): Promise<RenderResult> {
    return this.post<RenderResult>("/tasks/render", args, HttpWorkerClient.RENDER_TIMEOUT_MS);
  }

  async dispatch(args: WorkerDispatchRequest): Promise<ChannelDispatchResult[]> {
    const { results } = await this.post<{ results: ChannelDispatchResult[] }>(
      "/tasks/dispatch",
      args,
      HttpWorkerClient.DISPATCH_TIMEOUT_MS,
    );
    return results;
  }

  async ingest(args: WorkerIngestRequest): Promise<IngestReport> {
    return this.post<IngestReport>("/tasks/ingest", args, HttpWorkerClient.INGEST_TIMEOUT_MS);
  }
}

/**
 * Select the transport from the environment: WORKER_URL set → HTTP to the
 * worker service; unset → in-process handlers over the given db handle (the
 * only mode that works with a PGlite-backed dev database).
 */
export function createWorkerClient(db: Db): WorkerClient {
  const workerUrl = process.env.WORKER_URL;
  if (workerUrl) return new HttpWorkerClient(workerUrl);
  return new InProcessWorkerClient(db);
}
