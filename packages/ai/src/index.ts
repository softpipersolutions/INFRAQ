/**
 * @pebble/ai — two-lane AI orchestration (spec §4.4), Vercel AI SDK.
 *
 * Gemini Flash = retrieval/extraction; Claude (Sonnet default, Opus 4.8
 * escalation) = interpretation/drafting. A deterministic-first router assigns
 * each turn; COMPUTE-class work always goes to @pebble/engines, never a model.
 * The model can read, retrieve, explain and PROPOSE — it can never compute a
 * price or mutate an estimate.
 *
 * Everything here is dependency-injected (models, classifier, services) so the
 * orchestration logic is unit-testable without any API key.
 */
export * from "./models";
export * from "./router";
export * from "./slots";
export * from "./digest";
export * from "./prompts";
export * from "./tools";
export * from "./extract";
export * from "./embeddings";
export * from "./ingest/schemas";
export * from "./ingest/prompts";
export * from "./ingest/extract";
export * from "./ingest/eval-score";
export * from "./ingest/model";
