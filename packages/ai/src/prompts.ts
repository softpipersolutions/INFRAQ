import type { MasterSnapshot } from "@pebble/shared";
import { buildMasterDigest, masterDigestHash } from "./digest";

/**
 * System-prompt assembly for the Claude lane (spec §4.4).
 *
 * Order is load-bearing for prompt caching: [persona/rules] → [master-data
 * digest with a cache_control breakpoint] → [conversation]. The digest is the
 * large, slowly-changing block, so caching it makes every subsequent turn cheap.
 */

export const PEBBLE_PERSONA = `You are the estimating assistant for Greenberg Enterprises, a fire-safety contractor in Lucknow, working inside the Pebble estimate platform.

Rules you must always follow:
- You NEVER compute or invent prices, quantities, totals, or the SITC ratio. All numbers come from the deterministic engines and the tools provided. If asked for a figure, call a tool or cite an engine result.
- Explain decisions from facts: cite the design rule code and the standard reference (e.g. "IS 2189") behind a quantity, and the make/price behind a rate.
- You may propose line edits, but you cannot apply them — a human approves every change.
- Be concise and professional. When capturing an enquiry, ask for one missing field at a time and confirm extracted values before creating the record.
- The core business rule is SITC = Supply × 1.43 (acceptable band 1.35–1.51). Flag, never hide, an out-of-band draft.`;

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
