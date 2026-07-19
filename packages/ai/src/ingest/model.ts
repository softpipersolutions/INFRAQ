import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import type { LanguageModel } from "ai";
import { modelConfigFromEnv } from "../models";

/**
 * The single env → Gemini-extraction-model seam for the Phase B ingestion
 * worker.
 *
 * The provider factories are dependencies of THIS package, not of
 * `apps/worker` — so the worker cannot (and must not) build the model itself.
 * Two lanes, selected by env:
 *
 *  - **Vertex AI** (`PEBBLE_AI_PROVIDER=vertex`, or `GOOGLE_VERTEX_PROJECT`
 *    set): bills the GCP project postpaid via IAM — ambient ADC on Cloud Run,
 *    and locally either real ADC or a short-lived `GOOGLE_VERTEX_ACCESS_TOKEN`
 *    (e.g. `gcloud auth print-access-token`) passed as a bearer header, which
 *    avoids minting any long-lived local credential. Location defaults to
 *    "global" (where the gemini flash models serve from).
 *  - **Gemini Developer API** (`GOOGLE_GENERATIVE_AI_API_KEY`): the original
 *    prepaid-key lane, kept for portability.
 *
 * Returns `null` when neither lane is configured so callers degrade
 * deterministically (PDFs error with a clear 503; XLSX still ingest, since
 * their extraction is model-free). Construction is side-effect free and never
 * touches the network.
 */

/** Re-exported so `@pebble/worker` (which does not depend on `ai`) can name the type. */
export type { LanguageModel };

function wantsVertex(env: Record<string, string | undefined>): boolean {
  if (env.PEBBLE_AI_PROVIDER === "vertex") return true;
  if (env.PEBBLE_AI_PROVIDER) return false;
  return Boolean(env.GOOGLE_VERTEX_PROJECT);
}

/** Shared Vertex provider construction (model + embedder lanes). */
export function createVertexProvider(env: Record<string, string | undefined>) {
  const accessToken = env.GOOGLE_VERTEX_ACCESS_TOKEN;
  return createVertex({
    project: env.GOOGLE_VERTEX_PROJECT,
    location: env.GOOGLE_VERTEX_LOCATION ?? "global",
    ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
  });
}

/**
 * Build a Gemini `LanguageModel` for an explicit model id via the same
 * env-driven lane selection the ingestion worker uses (Vertex postpaid, else
 * Developer-API prepaid, else null). Extracted so the chat classifier lane
 * (`createChatModelsFromEnv`) reuses this exact selection instead of
 * duplicating it. Returns null when neither Google lane is configured.
 */
export function createGeminiModelFromEnv(
  env: Record<string, string | undefined>,
  modelId: string,
): LanguageModel | null {
  if (wantsVertex(env)) {
    return createVertexProvider(env)(modelId);
  }
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) return null;
  return createGoogleGenerativeAI({ apiKey })(modelId);
}

export function createIngestModelFromEnv(
  env: Record<string, string | undefined>,
): LanguageModel | null {
  const modelId = env.PEBBLE_INGEST_MODEL ?? modelConfigFromEnv(env).gemini;
  return createGeminiModelFromEnv(env, modelId);
}
