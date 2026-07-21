import type { MasterSnapshot } from "@pebble/shared";
import { buildMasterDigest, masterDigestHash } from "./digest";
import { PEBBLE_PERSONA } from "./agent/persona";
import { ephemeralCacheControl, resolveCacheTtl, type EphemeralCacheControl } from "./cache";

/**
 * System-prompt assembly for the Claude lane (spec §4.4).
 *
 * Order is load-bearing for prompt caching: [persona/rules] → [master-data
 * digest with a cache_control breakpoint] → [conversation]. The digest is the
 * large, slowly-changing block, so caching it makes every subsequent turn cheap.
 *
 * The persona now lives in `agent/persona.ts` (Phase C.5, the full Pebble
 * persona). It is re-exported here so existing importers keep working; the
 * assembly shape and cache-breakpoint placement below are unchanged.
 *
 * WP10: the breakpoint's ttl is env-driven (`PEBBLE_CACHE_TTL`, via
 * `resolveCacheTtl`/`ephemeralCacheControl` in `./cache`) — the SAME helper
 * `chat-agent.ts` uses for the per-turn user-message breakpoint, so both
 * breakpoints always agree on the ttl in effect for a turn.
 */

export { PEBBLE_PERSONA };

/** A system prompt block; the digest block is marked cacheable. */
export interface SystemBlock {
  role: "system";
  content: string;
  /** Anthropic ephemeral cache breakpoint (only on the digest block). */
  providerOptions?: { anthropic: { cacheControl: EphemeralCacheControl } };
}

export interface AssembledPrompt {
  blocks: SystemBlock[];
  digestHash: string;
}

/**
 * Build the ordered system blocks. Pass the previously-seen digest hash to skip
 * re-rendering when masters are unchanged (the caller keeps the cached digest).
 * Pass `env` to resolve the cache ttl (`PEBBLE_CACHE_TTL`) for the digest
 * block's breakpoint; defaults to `process.env`.
 */
export function assembleSystemPrompt(
  snapshot: MasterSnapshot,
  opts: {
    cachedDigest?: { hash: string; text: string };
    env?: Record<string, string | undefined>;
  } = {},
): AssembledPrompt {
  const hash = masterDigestHash(snapshot);
  const digestText =
    opts.cachedDigest && opts.cachedDigest.hash === hash
      ? opts.cachedDigest.text
      : buildMasterDigest(snapshot);
  const ttl = resolveCacheTtl(opts.env);

  return {
    digestHash: hash,
    blocks: [
      { role: "system", content: PEBBLE_PERSONA },
      {
        role: "system",
        content: digestText,
        providerOptions: { anthropic: { cacheControl: ephemeralCacheControl(ttl) } },
      },
    ],
  };
}
