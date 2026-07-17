import {
  APPLICABLE_STANDARDS,
  BUILDING_TYPES,
  EXPR_FUNCTIONS,
  EXPR_IDENTIFIERS,
  MAKE_PREFERENCES,
  MAKE_TIERS,
  SYSTEM_TYPES,
} from "@pebble/shared";
import type { ExprFunction, ExprIdentifier } from "@pebble/shared";

/**
 * Name resolution for rule expressions.
 *
 * Three disjoint namespaces, checked in order:
 *   1. the 8 context identifiers (exact match)   → value read from ExprContext
 *   2. function names (case-insensitive)         → CEIL, FLOOR, ROUND, MIN, MAX, IF, CLAMP
 *   3. enum vocabulary words (case-insensitive,  → string constants: Commercial,
 *      underscores read as spaces)                 NBC_2016 → "NBC 2016", ...
 *
 * All lookups go through Maps/Sets — a hostile identifier such as
 * "__proto__" or "toString" can never reach an object prototype chain.
 */

/** Static type lattice used by validation. */
export type StaticType = "number" | "string" | "boolean" | "unknown";

/** Normalize a vocabulary word: trim, lowercase, underscores → single spaces. */
function normalizeWord(word: string): string {
  return word.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}

/** normalized word → canonical enum value ("nbc 2016" → "NBC 2016"). */
const VOCABULARY = new Map<string, string>();
for (const values of [
  BUILDING_TYPES,
  SYSTEM_TYPES,
  MAKE_TIERS,
  MAKE_PREFERENCES,
  APPLICABLE_STANDARDS,
] as readonly (readonly string[])[]) {
  for (const value of values) VOCABULARY.set(normalizeWord(value), value);
}

const CONTEXT_IDENTIFIERS: ReadonlySet<string> = new Set(EXPR_IDENTIFIERS);

/** lowercased function name → canonical function name ("ceil" → "CEIL"). */
const FUNCTION_TABLE = new Map<string, ExprFunction>();
for (const fn of EXPR_FUNCTIONS) FUNCTION_TABLE.set(fn.toLowerCase(), fn);

/** Static type of each context identifier (mirrors the ExprContext interface). */
export const IDENTIFIER_TYPES: Readonly<Record<ExprIdentifier, "number" | "string">> = {
  building_type: "string",
  floors_above: "number",
  floor_area_sqm: "number",
  total_area_sqm: "number",
  system: "string",
  make_preference: "string",
  applicable_standard: "string",
  project_tier: "number",
};

/** Is `name` one of the 8 ExprContext identifiers (exact match)? */
export function isContextIdentifier(name: string): name is ExprIdentifier {
  return CONTEXT_IDENTIFIERS.has(name);
}

/**
 * Resolve a bare identifier as an enum vocabulary word. Returns the canonical
 * enum value ("As_per_Greenberg" → "As per Greenberg"), or null when the word
 * is not part of the known vocabulary.
 */
export function resolveEnumWord(name: string): string | null {
  return VOCABULARY.get(normalizeWord(name)) ?? null;
}

/** Resolve a function name case-insensitively to its canonical form, or null. */
export function resolveFunctionName(name: string): ExprFunction | null {
  return FUNCTION_TABLE.get(name.trim().toLowerCase()) ?? null;
}
