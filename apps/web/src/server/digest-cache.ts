import "server-only";

import { assembleSystemPrompt, type SystemBlock } from "@pebble/ai";
import { loadMasterSnapshot, type Db } from "@pebble/db";

/**
 * Master-data digest cache for the Claude lane (spec §4.4, prompt caching).
 *
 * `assembleSystemPrompt` renders the (large, slowly-changing) master digest and
 * keys it by a content hash over the masters. We keep the last rendered digest
 * at module scope and hand it back to `assembleSystemPrompt` so the expensive
 * text render is rebuilt ONLY when the hash changes (an admin edits a rate or
 * rule). The digest block carries the Anthropic `cache_control` breakpoint, so
 * cache hits persist across every chat until the masters actually change.
 */

let cached: { hash: string; text: string } | null = null;

export interface CachedDigest {
  /** Ordered system blocks: [persona] → [digest with cache_control]. */
  blocks: SystemBlock[];
  hash: string;
  /** True when this call reused the previously-rendered digest text. */
  hit: boolean;
}

export async function getCachedDigest(db: Db): Promise<CachedDigest> {
  const snapshot = await loadMasterSnapshot(db);
  const previous = cached;
  const assembled = assembleSystemPrompt(snapshot, {
    cachedDigest: previous ?? undefined,
  });
  const hit = previous !== null && previous.hash === assembled.digestHash;

  // The digest block is the second system block (persona is first).
  const digestBlock = assembled.blocks[1];
  cached = { hash: assembled.digestHash, text: digestBlock?.content ?? "" };

  return { blocks: assembled.blocks, hash: assembled.digestHash, hit };
}

/** Test/ops hook: drop the cached digest so the next call re-renders. */
export function resetDigestCache(): void {
  cached = null;
}
