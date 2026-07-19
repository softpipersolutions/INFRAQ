import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { modelConfigFromEnv } from "../models";

/**
 * The single env → Gemini-extraction-model seam for the Phase B ingestion
 * worker.
 *
 * The `@ai-sdk/google` provider factory is a dependency of THIS package, not of
 * `apps/worker` — so the worker cannot (and must not) build the model itself.
 * This helper is the one place that turns `GOOGLE_GENERATIVE_AI_API_KEY` (plus
 * the `PEBBLE_INGEST_MODEL` / `PEBBLE_GEMINI_MODEL` overrides) into a concrete
 * `LanguageModel`, returning `null` when no key is configured so callers can
 * degrade deterministically (PDFs error with a clear 503; XLSX still ingest,
 * since their extraction is model-free).
 *
 * Construction is side-effect free and never touches the network — the returned
 * model only calls out when `generateObject` is invoked — so it is safe to call
 * on every boot regardless of whether extraction is actually configured.
 */

/** Re-exported so `@pebble/worker` (which does not depend on `ai`) can name the type. */
export type { LanguageModel };

export function createIngestModelFromEnv(
  env: Record<string, string | undefined>,
): LanguageModel | null {
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) return null;
  const modelId = env.PEBBLE_INGEST_MODEL ?? modelConfigFromEnv(env).gemini;
  return createGoogleGenerativeAI({ apiKey })(modelId);
}
