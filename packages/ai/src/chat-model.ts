import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { createGeminiModelFromEnv } from "./ingest/model";
import { modelConfigFromEnv } from "./models";

/**
 * The single env → chat-lane-models seam for the Phase C conversational route.
 *
 * The provider factories are dependencies of THIS package (`@ai-sdk/anthropic`,
 * `@ai-sdk/google`), so `apps/web` never constructs a provider itself — it
 * imports the models built here. Three models, each independently nullable so
 * the route degrades deterministically:
 *
 *  - `classifier`   → the Gemini retrieval model (router intent classification
 *    + slot-filling extraction), via the SAME Vertex/Developer-API selection
 *    the ingestion lane uses. Null when no Google lane is configured.
 *  - `claudeDefault` / `claudeOpus` → the interpretation/drafting lane's Sonnet
 *    default and Opus escalation models, built from `ANTHROPIC_API_KEY` with
 *    ids resolved via `modelConfigFromEnv` (env-overridable). Both null when no
 *    Anthropic key is set — the route then returns a graceful 503.
 *
 * Construction is side-effect free and never touches the network.
 */
export interface ChatModels {
  classifier: LanguageModel | null;
  claudeDefault: LanguageModel | null;
  claudeOpus: LanguageModel | null;
}

export function createChatModelsFromEnv(env: Record<string, string | undefined>): ChatModels {
  const models = modelConfigFromEnv(env);

  const classifier = createGeminiModelFromEnv(env, models.gemini);

  const anthropicKey = env.ANTHROPIC_API_KEY;
  let claudeDefault: LanguageModel | null = null;
  let claudeOpus: LanguageModel | null = null;
  if (anthropicKey) {
    const anthropic = createAnthropic({ apiKey: anthropicKey });
    claudeDefault = anthropic(models.claudeDefault);
    claudeOpus = anthropic(models.claudeOpus);
  }

  return { classifier, claudeDefault, claudeOpus };
}
