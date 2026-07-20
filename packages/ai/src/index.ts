/**
 * @pebble/ai — the module-agnostic agent core + AI orchestration, Vercel AI SDK.
 *
 * Phase C.5: the chat is a single Claude-Sonnet-5 agent that owns every reply and
 * orchestrates the workflow through tools (see `agent/`). Gemini Flash keeps
 * three jobs — field extraction, embeddings, and running-summary compaction; the
 * deterministic engines still compute all money. The agent can read, retrieve,
 * explain and PROPOSE, but never computes a figure, mutates an estimate, or
 * approves/dispatches.
 *
 * `agent/registry.ts` is the ERP seam: modules plug in as `ModuleToolset`s and
 * `composeAgent` folds them into one turn. Deterministic Opus escalation lives
 * in `agent/escalation.ts`; the old lane router/classifier are gone (WP3).
 *
 * Everything is dependency-injected (models, services) so the orchestration is
 * unit-testable without any API key.
 */

// Agent core (Phase C.5).
export * from "./agent/registry";
export * from "./agent/ask-user";
export * from "./agent/persona";
export * from "./agent/module02";
export * from "./agent/attachments";
export * from "./agent/memory";
export * from "./agent/escalation";
export * from "./agent/compaction";
export * from "./agent/context";
export * from "./agent/title";

export * from "./models";
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
export * from "./ingest/verify";
export * from "./chat-model";
export * from "./skills-lane";
