import { serve } from "@hono/node-server";
import { createEmbedder, createIngestModelFromEnv } from "@pebble/ai";
import { createDb, migrateDb } from "@pebble/db";
import { createEmailProvider, createWhatsAppProvider } from "@pebble/dispatch";
import { createApp } from "./app";
import type { AppDeps } from "./app";
import { createPdfRenderer } from "./pdf";
import { createStorage } from "./storage";

/**
 * Worker entrypoint. Builds the concrete dependencies from the environment
 * (db handle, storage backend, PDF renderer, dispatch providers), wires them
 * into the Hono app, and serves on `PORT` (default 8080, the Cloud Run
 * contract). On the embedded PGlite driver — i.e. local dev with no
 * `DATABASE_URL` — migrations are applied on boot so a fresh checkout is
 * immediately usable; against Cloud SQL, migrations run as a pre-deploy job
 * (see infra/README.md) and are NOT re-run here.
 */
async function main(): Promise<void> {
  const handle = await createDb();
  if (handle.kind === "pglite") {
    await migrateDb(handle);
  }

  const deps: AppDeps = {
    db: handle.db,
    storage: createStorage(process.env),
    pdf: createPdfRenderer(process.env),
    providers: {
      email: createEmailProvider(process.env),
      whatsapp: createWhatsAppProvider(process.env),
    },
    ingestAi: {
      // Gemini extraction model when GOOGLE_GENERATIVE_AI_API_KEY is set, else null
      // (PDF ingestion errors 503; XLSX still ingest deterministically).
      model: createIngestModelFromEnv(process.env),
      embedder: createEmbedder(process.env),
    },
  };

  const app = createApp(deps);
  const port = Number(process.env.PORT ?? 8080);

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[worker] listening on :${info.port} (db=${handle.kind})`);
  });
}

main().catch((err) => {
  console.error("[worker] failed to start:", err);
  process.exitCode = 1;
});
