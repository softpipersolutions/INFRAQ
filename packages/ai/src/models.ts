/**
 * Model configuration for the two AI lanes (spec §4.4).
 *
 * - Gemini Flash  → retrieval/extraction lane (LOOKUP / EXTRACT / RECALL)
 * - Claude Sonnet → interpretation/drafting lane, default
 * - Claude Opus 4.8 → escalation within the Claude lane (explicit triggers only)
 *
 * COMPUTE-class work never touches a model — it goes to @pebble/engines.
 *
 * Every id is env-overridable so ops can pin/upgrade models without a redeploy.
 */

export type Lane = "gemini" | "claude" | "engine";

export interface ModelConfig {
  /** Default Claude generation model. */
  claudeDefault: string;
  /** Escalation Claude model (higher reasoning, higher cost). */
  claudeOpus: string;
  /** Gemini retrieval/extraction model. */
  gemini: string;
}

/** Project defaults (PROGRESS.md §3) — overridable via env. */
export const DEFAULT_MODELS: ModelConfig = {
  claudeDefault: "claude-sonnet-4-6",
  claudeOpus: "claude-opus-4-8",
  gemini: "gemini-3.5-flash",
};

export function modelConfigFromEnv(env: Record<string, string | undefined> = process.env): ModelConfig {
  return {
    claudeDefault: env.PEBBLE_CLAUDE_DEFAULT_MODEL ?? DEFAULT_MODELS.claudeDefault,
    claudeOpus: env.PEBBLE_CLAUDE_OPUS_MODEL ?? DEFAULT_MODELS.claudeOpus,
    gemini: env.PEBBLE_GEMINI_MODEL ?? DEFAULT_MODELS.gemini,
  };
}

/** Provider inferred from a model id — used to pick the right AI-SDK provider. */
export function providerForModel(model: string): "anthropic" | "google" {
  return model.startsWith("gemini") ? "google" : "anthropic";
}

/**
 * Rough $/million-token rates for the cost dashboard (llm_calls). Approximate —
 * the point is a live cost signal, not billing-grade accounting. Keyed by a
 * prefix match so pinned/dated model ids still resolve.
 */
interface Rate {
  inPerM: number;
  outPerM: number;
}
const RATE_TABLE: Array<{ prefix: string; rate: Rate }> = [
  { prefix: "claude-opus", rate: { inPerM: 15, outPerM: 75 } },
  { prefix: "claude-sonnet", rate: { inPerM: 3, outPerM: 15 } },
  { prefix: "claude-haiku", rate: { inPerM: 0.8, outPerM: 4 } },
  { prefix: "gemini", rate: { inPerM: 0.15, outPerM: 0.6 } },
];
const FALLBACK_RATE: Rate = { inPerM: 3, outPerM: 15 };

export function rateForModel(model: string): Rate {
  return RATE_TABLE.find((r) => model.startsWith(r.prefix))?.rate ?? FALLBACK_RATE;
}

/** Anthropic prompt-caching billing multipliers on the input rate. */
const CACHE_READ_MULTIPLIER = 0.1; // cache hits bill at 10% of input
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute cache writes bill at 125%

export interface CacheUsage {
  /** Tokens read from the prompt cache (usage.cachedInputTokens). */
  cacheReadTokens?: number;
  /** Tokens written to the cache (anthropic cache_creation_input_tokens). */
  cacheWriteTokens?: number;
}

/**
 * Estimated USD cost of a call — stored on each llm_calls row.
 *
 * `inputTokens` is the FRESH (uncached) input; cached reads/writes bill at
 * their own multipliers and were previously ignored, which understated every
 * cached Claude turn on the dashboard tile.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache?: CacheUsage,
): number {
  const rate = rateForModel(model);
  const usd =
    (inputTokens / 1_000_000) * rate.inPerM +
    (outputTokens / 1_000_000) * rate.outPerM +
    (((cache?.cacheReadTokens ?? 0) / 1_000_000) * rate.inPerM) * CACHE_READ_MULTIPLIER +
    (((cache?.cacheWriteTokens ?? 0) / 1_000_000) * rate.inPerM) * CACHE_WRITE_MULTIPLIER;
  return Math.round(usd * 1_000_000) / 1_000_000; // 6dp — matches NUMERIC(10,6)
}

/** One row for the llm_calls cost/latency ledger. */
export interface LlmCallLog {
  lane: Lane;
  model: string;
  intent: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionId?: string | null;
}

export function toLlmCallLog(args: {
  lane: Lane;
  model: string;
  intent?: string | null;
  inputTokens: number;
  outputTokens: number;
  sessionId?: string | null;
  cache?: CacheUsage;
}): LlmCallLog {
  return {
    lane: args.lane,
    model: args.model,
    intent: args.intent ?? null,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    costUsd: estimateCostUsd(args.model, args.inputTokens, args.outputTokens, args.cache),
    sessionId: args.sessionId ?? null,
  };
}
