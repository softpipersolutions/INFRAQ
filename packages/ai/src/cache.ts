/**
 * Anthropic prompt-cache TTL — the ONE env → cache-breakpoint seam (WP10).
 *
 * Anthropic supports two ephemeral cache lifetimes: the default 5-minute
 * window, and an opt-in 1-hour window (higher write cost, fewer cache misses
 * on slower conversations). `PEBBLE_CACHE_TTL` picks the lifetime for BOTH
 * breakpoints this app sets — the master-digest block
 * (`prompts.ts#assembleSystemPrompt`) and the per-turn user-message block
 * (`chat-agent.ts`) — so the two breakpoints are never out of sync.
 *
 * `resolveCacheTtl` is the single source of truth for parsing the env var;
 * `ephemeralCacheControl` turns the resolved ttl into the exact
 * `providerOptions.anthropic.cacheControl` shape the AI SDK forwards to
 * Anthropic. The write-price multiplier that goes with each ttl lives in
 * `models.ts` (`CACHE_WRITE_MULTIPLIER`), keyed by this same `CacheTtl` type.
 */

export type CacheTtl = "5m" | "1h";

export const DEFAULT_CACHE_TTL: CacheTtl = "5m";

/**
 * Resolve the active cache ttl from env. Anything other than the literal
 * string `"1h"` (case-insensitive, surrounding whitespace tolerated) falls
 * back to the 5-minute default — so an unset, empty, or mistyped
 * `PEBBLE_CACHE_TTL` never silently switches everyone onto the pricier 1h tier.
 */
export function resolveCacheTtl(env: Record<string, string | undefined> = process.env): CacheTtl {
  const raw = (env.PEBBLE_CACHE_TTL ?? "").trim().toLowerCase();
  return raw === "1h" ? "1h" : DEFAULT_CACHE_TTL;
}

/**
 * The Anthropic ephemeral cache-control shape for a given ttl (via
 * `@ai-sdk/anthropic` `providerOptions`). Deliberately a `type` alias, NOT an
 * `interface`: the AI SDK's `providerOptions` value type requires a plain
 * (index-signature-compatible) JSON object, and only object-literal TYPES get
 * TypeScript's implicit index-signature inference — a named `interface` does
 * not, and fails assignability against `ModelMessage.providerOptions`.
 */
export type EphemeralCacheControl = {
  type: "ephemeral";
  /** Omitted for the 5-minute default — only set (to "1h") on the opt-in long-lived tier. */
  ttl?: "1h";
};

/** Build the provider-options cache_control value for `ttl` — `{type:"ephemeral"}` for 5m, `{type:"ephemeral",ttl:"1h"}` for 1h. */
export function ephemeralCacheControl(ttl: CacheTtl): EphemeralCacheControl {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}
