import type { MasterSnapshot } from "@pebble/shared";
import { buildMasterDigest, masterDigestHash } from "./digest";
import { PEBBLE_PERSONA } from "./agent/persona";

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
 */

export { PEBBLE_PERSONA };

/** A system prompt block; the digest block is marked cacheable. */
export interface SystemBlock {
  role: "system";
  content: string;
  /** Anthropic ephemeral cache breakpoint (only on the digest block). */
  providerOptions?: { anthropic: { cacheControl: { type: "ephemeral" } } };
}

export interface AssembledPrompt {
  blocks: SystemBlock[];
  digestHash: string;
}

/**
 * Build the ordered system blocks. Pass the previously-seen digest hash to skip
 * re-rendering when masters are unchanged (the caller keeps the cached digest).
 */
export function assembleSystemPrompt(
  snapshot: MasterSnapshot,
  opts: { cachedDigest?: { hash: string; text: string } } = {},
): AssembledPrompt {
  const hash = masterDigestHash(snapshot);
  const digestText =
    opts.cachedDigest && opts.cachedDigest.hash === hash
      ? opts.cachedDigest.text
      : buildMasterDigest(snapshot);

  return {
    digestHash: hash,
    blocks: [
      { role: "system", content: PEBBLE_PERSONA },
      {
        role: "system",
        content: digestText,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ],
  };
}
