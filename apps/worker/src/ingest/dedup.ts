import type { Embedder } from "@pebble/ai";
import type { Db } from "@pebble/db";
import { listMaterials, nearestMaterialNames, trgmMaterialCandidates } from "@pebble/db";
import { stripMarkTokens } from "@pebble/shared";
import type { NormalizedLine } from "./normalize";

/**
 * Dedup routing for the staging pass (PLAN §4.5 step 5). One extracted+normalized
 * line has to be routed to ONE of three fates before it is staged:
 *   - the material it names ALREADY EXISTS → stage a price point / make link on
 *     that material (`prices`);
 *   - it PROBABLY matches an existing material but not confidently → stage it as
 *     a new material, but carry the candidate code so a reviewer can merge
 *     (`materials` + dedupCandidateCode);
 *   - it names something genuinely new → stage a fresh material (`materials`).
 *
 * The router is deliberately CONSERVATIVE: it only auto-treats a line as an
 * existing material on a STRONG trigram (or embedding) match; everything short of
 * that lands in `materials` for a human to confirm. It never invents a link.
 *
 * Two matchers, cheap-first:
 *   1. pg_trgm fuzzy name similarity (always) — the primary signal.
 *   2. an embedding fallback (only when an embedder is supplied AND the register
 *      already holds a material of the same guessed system, so we don't burn an
 *      embed call comparing against an empty/irrelevant space).
 */

/** Trigram similarity at/above which a name is treated as the SAME existing material. */
export const TRGM_STRONG = 0.82;
/** Trigram similarity in [POSSIBLE, STRONG) → a candidate for reviewer merge, staged as new. */
export const TRGM_POSSIBLE = 0.55;
/** Cosine similarity (1 − distance) at/above which an embedding match is treated as the same material. */
export const EMBED_STRONG = 0.88;
/** Cosine similarity in [POSSIBLE, STRONG) → an embedding-based reviewer-merge candidate. */
export const EMBED_POSSIBLE = 0.8;

export type LineTarget = "materials" | "prices" | "makes";
export type MatchKind = "strong" | "possible" | null;

export interface LineTargetResult {
  targetMaster: LineTarget;
  dedupCandidateCode: string | null;
  matchKind: MatchKind;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The "material-ish" name to match/dedup on: the printed description with the
 * inline make clause, brand tokens and certification noise peeled off, so
 * "SITC M.S. Pipe 50 mm; Make - Jindal (ISI)" reduces to "M.S. Pipe 50 mm".
 * SIZES ARE KEPT (they distinguish 50 mm from 100 mm pipe); only brand/cert
 * cruft is removed. Original casing is preserved for storage — `classifyLineTarget`
 * lowercases it for the (case-insensitive) trigram query itself.
 */
export function materialishName(normalized: NormalizedLine): string {
  let s = normalized.description;
  // Drop an inline "…; Make - Jindal" / "Make: X" clause through end-of-string.
  s = s.replace(/[;,]?\s*make\s*[-:].*/is, " ");
  // Remove any brand tokens (raw, canonical, and OR-alternatives) still inline.
  const brands = [normalized.brand.normalized, normalized.brand.raw, ...normalized.brand.alternatives];
  for (const b of brands) {
    const token = b?.trim();
    if (token && token.length > 0) {
      s = s.replace(new RegExp(escapeRegExp(token), "gi"), " ");
    }
  }
  // Strip certification / approval marks ((ISI), (UL), FM approved, CE, …).
  s = stripMarkTokens(s);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : normalized.description.trim();
}

/**
 * Route one normalized line to a target master + optional dedup candidate.
 * Honest by construction: anything not a STRONG match falls to `materials` (with
 * the best candidate attached when there is a plausible one) so a human, never
 * this code, decides a merge.
 */
export async function classifyLineTarget(
  db: Db,
  normalized: NormalizedLine,
  opts: { embedder?: Embedder | null },
): Promise<LineTargetResult> {
  const name = materialishName(normalized);
  const candidates = await trgmMaterialCandidates(db, name.toLowerCase(), 5);
  const top = candidates[0];

  if (top && top.similarity >= TRGM_STRONG) {
    // Existing material — stage a price/make against it. (Make link handled at commit.)
    return { targetMaster: "prices", dedupCandidateCode: top.materialCode, matchKind: "strong" };
  }
  if (top && top.similarity >= TRGM_POSSIBLE) {
    // Plausible but unconfirmed — stage as NEW, carry the candidate for reviewer merge.
    return { targetMaster: "materials", dedupCandidateCode: top.materialCode, matchKind: "possible" };
  }

  // Embedding fallback — only worth an embed call when we have an embedder AND
  // the register already holds a material of this line's guessed system.
  const embedder = opts.embedder;
  if (embedder && normalized.systemGuess) {
    const materials = await listMaterials(db);
    const sameSystemCodes = new Set(
      materials.filter((m) => m.systemType === normalized.systemGuess).map((m) => m.materialCode),
    );
    if (sameSystemCodes.size > 0) {
      const [vec] = await embedder.embed([name]);
      if (vec) {
        const nearest = await nearestMaterialNames(db, vec, 5);
        const best = nearest.find((n) => sameSystemCodes.has(n.materialCode));
        if (best) {
          const similarity = 1 - best.cosine; // nearestMaterialNames returns cosine DISTANCE
          if (similarity >= EMBED_STRONG) {
            return { targetMaster: "prices", dedupCandidateCode: best.materialCode, matchKind: "strong" };
          }
          if (similarity >= EMBED_POSSIBLE) {
            return { targetMaster: "materials", dedupCandidateCode: best.materialCode, matchKind: "possible" };
          }
        }
      }
    }
  }

  // In doubt → a brand-new material, no candidate.
  return { targetMaster: "materials", dedupCandidateCode: null, matchKind: null };
}
