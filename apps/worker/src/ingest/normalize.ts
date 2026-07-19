import {
  splitBrandAlternatives,
  toPaise,
  tryNormalizeBrand,
  tryNormalizeUnit,
  type MaterialCategory,
  type SystemType,
  type UnitOfMeasure,
} from "@pebble/shared";
import type { RawLine } from "./types";

/**
 * Pure normalization of one `RawLine` (PLAN §4.5 step 4): resolve unit/brand
 * aliases via `@pebble/shared`'s observed-alias tables, convert rupee text to
 * integer paise, cross-check qty × rate against the printed amount, and take
 * a best-effort keyword guess at system/category — all without ever
 * inventing a canonical value the shared tables have not seen (an unknown
 * unit/brand normalizes to `null`, left for human review downstream).
 */

export type CrossCheckResult = "ok" | "mismatch" | "n/a";

export interface NormalizedLine extends Omit<RawLine, "confidence"> {
  unit: { raw: string | null; normalized: UnitOfMeasure | null };
  brand: { raw: string | null; normalized: string | null; alternatives: string[] };
  sellPaise: number | null;
  amountPaise: number | null;
  crossCheck: CrossCheckResult;
  /** Adjusted from `raw.confidence` by the cross-check outcome (see `normalizeLine`). */
  confidence: number;
  systemGuess: SystemType | null;
  categoryGuess: string | null;
  /** Non-fatal issues hit while normalizing this line (e.g. an absurd rupee value). */
  warnings: string[];
}

const CROSS_CHECK_RELATIVE_TOLERANCE = 0.01; // 1%
const CONFIDENCE_BONUS = 0.05;
const CONFIDENCE_PENALTY = 0.2;

/** Keyword → SystemType, checked in this priority order (spec's listed order). */
const SYSTEM_KEYWORDS: ReadonlyArray<{ system: SystemType; re: RegExp }> = [
  { system: "Sprinkler", re: /\bsprinklers?\b/i },
  { system: "Hydrant", re: /\b(hydrants?|risers?|hoses?)\b/i },
  { system: "FAS", re: /\b(smoke|detectors?|alarms?|panels?|mcp|hooters?)\b/i },
  { system: "Extinguisher", re: /\b(extinguishers?|abc|co ?2)\b/i },
  { system: "Suppression", re: /\b(suppression|novec|fm[-\s]?200)\b/i },
];

/** Keyword → MaterialCategory, checked in the enum's declared order. */
const CATEGORY_KEYWORDS: ReadonlyArray<{ category: MaterialCategory; re: RegExp }> = [
  { category: "Detector", re: /\bdetectors?\b/i },
  { category: "Panel", re: /\bpanels?\b/i },
  { category: "Cable", re: /\b(cables?|wiring)\b/i },
  { category: "Pipe", re: /\bpipes?\b/i },
  { category: "Valve", re: /\bvalves?\b/i },
  { category: "Pump", re: /\bpumps?\b/i },
  { category: "Fitting", re: /\bfittings?\b/i },
  { category: "Extinguisher", re: /\bextinguishers?\b/i },
  { category: "Accessory", re: /\baccessor(?:y|ies)\b/i },
  { category: "Signage", re: /\bsignages?\b/i },
];

function guessSystem(haystack: string): SystemType | null {
  for (const { system, re } of SYSTEM_KEYWORDS) {
    if (re.test(haystack)) return system;
  }
  return null;
}

function guessCategory(haystack: string): MaterialCategory | null {
  for (const { category, re } of CATEGORY_KEYWORDS) {
    if (re.test(haystack)) return category;
  }
  return null;
}

/** Convert a rupee amount to paise, catching `toPaise`'s throw on absurd/non-finite input. */
function safeToPaise(rupees: number | null, ctx: string, warnings: string[]): number | null {
  if (rupees === null) return null;
  try {
    return toPaise(rupees, ctx);
  } catch (err) {
    warnings.push(`${ctx}: could not convert ${rupees} to paise (${(err as Error).message})`);
    return null;
  }
}

/**
 * Strip characters PostgreSQL cannot store in text/jsonb. Gemini occasionally
 * transcribes glyphs it can't map (e.g. the degree symbol in "54°C") as a NUL
 * byte — PGlite silently tolerates that in bound params, but real Postgres
 * rejects the statement, which failed a Cloud SQL ingest mid-corpus. NUL and
 * other C0 controls (except tab/newline) become spaces; whitespace collapses.
 */
function scrubText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function scrubTextOrNull(s: string | null): string | null {
  if (s === null) return null;
  const scrubbed = scrubText(s);
  return scrubbed.length > 0 ? scrubbed : null;
}

export function normalizeLine(input: RawLine): NormalizedLine {
  const raw: RawLine = {
    ...input,
    description: scrubText(input.description),
    makeRaw: scrubTextOrNull(input.makeRaw),
    unitRaw: scrubTextOrNull(input.unitRaw),
    section: scrubTextOrNull(input.section),
    slNo: scrubTextOrNull(input.slNo),
  };
  const warnings: string[] = [];

  const unitNormalized = raw.unitRaw !== null ? tryNormalizeUnit(raw.unitRaw) : null;

  let brandAlternatives: string[] = [];
  let brandNormalized: string | null = null;
  if (raw.makeRaw !== null && raw.makeRaw.trim().length > 0) {
    brandAlternatives = splitBrandAlternatives(raw.makeRaw);
    const primary = brandAlternatives[0] ?? raw.makeRaw;
    brandNormalized = tryNormalizeBrand(primary);
  }

  const sellPaise = safeToPaise(raw.unitRateRupees, "unitRateRupees", warnings);
  const amountPaise = safeToPaise(raw.amountRupees, "amountRupees", warnings);

  let crossCheck: CrossCheckResult = "n/a";
  let confidence = raw.confidence;
  if (raw.qty !== null && sellPaise !== null && amountPaise !== null) {
    const expected = raw.qty * sellPaise;
    const diff = Math.abs(expected - amountPaise);
    const base = Math.max(Math.abs(expected), Math.abs(amountPaise), 1);
    if (diff / base <= CROSS_CHECK_RELATIVE_TOLERANCE) {
      crossCheck = "ok";
      confidence = Math.min(1, confidence + CONFIDENCE_BONUS);
    } else {
      crossCheck = "mismatch";
      confidence = Math.max(0, confidence - CONFIDENCE_PENALTY);
    }
  }

  const haystack = `${raw.section ?? ""} ${raw.description}`;
  const systemGuess = guessSystem(haystack);
  const categoryGuess = guessCategory(haystack);

  return {
    ...raw,
    unit: { raw: raw.unitRaw, normalized: unitNormalized },
    brand: { raw: raw.makeRaw, normalized: brandNormalized, alternatives: brandAlternatives },
    sellPaise,
    amountPaise,
    crossCheck,
    confidence,
    systemGuess,
    categoryGuess: categoryGuess,
    warnings,
  };
}
