/**
 * Brand canonicalization map — every make variant observed in the 2022–2026
 * historical corpus (PDF proposals + DSR-style Excel estimates) maps to one
 * canonical brand name. Extend OBSERVED_BRAND_ALIASES as ingestion meets new
 * variants; ingestion must never invent a canonical name it has not seen, so an
 * unknown raw make normalizes to null and is left for human review.
 *
 * Raw makes in the corpus arrive wrapped in certification noise ("ISI Marked",
 * "(UL)"), vendor prefixes ("M/s", "Make -") and OR-alternatives ("Agni OR
 * Ravel"); stripMarkTokens / splitBrandAlternatives peel those off before the
 * alias lookup.
 */
const OBSERVED_BRAND_ALIASES: Record<string, string> = {
  // Agni Devices
  "agni": "Agni Devices", "agni devices": "Agni Devices", "agni device": "Agni Devices",
  // Honeywell
  "honeywell": "Honeywell", "honeywell (ul)": "Honeywell",
  // Siemens
  "siemens": "Siemens",
  // Notifier
  "notifier": "Notifier",
  // Edwards
  "edwards": "Edwards", "edwards est": "Edwards",
  // Simplex
  "simplex": "Simplex",
  // Jindal
  "jindal": "Jindal", "jindal (isi)": "Jindal", "jindal pipes": "Jindal",
  // Kartar
  "kartar": "Kartar", "kartar valves": "Kartar",
  // Zoloto
  "zoloto": "Zoloto",
  // Kirloskar
  "kirloskar": "Kirloskar", "kirloskar brothers": "Kirloskar",
  "m/s kirloskar": "Kirloskar", "kbl": "Kirloskar",
  // Lubi
  "lubi": "Lubi", "lubi pumps": "Lubi",
  // Tyco
  "tyco": "Tyco",
  // Omaxe
  "omaxe": "Omaxe",
  // Safepro
  "safepro": "Safepro", "safe pro": "Safepro",
  // Elitech
  "elitech": "Elitech",
  // Polycab
  "polycab": "Polycab",
  // Exide
  "exide": "Exide",
  // HD Fire
  "hd fire": "HD Fire", "hdfire": "HD Fire", "hd fire protect": "HD Fire",
  // Newage
  "newage": "Newage", "new age": "Newage",
  // Ravel
  "ravel": "Ravel",
  // GST
  "gst": "GST",
};

/**
 * Certification / approval marks and vendor labels that decorate a raw make but
 * carry no brand identity. Removed anywhere in the string (case-insensitive).
 */
const MARK_TOKEN_PATTERNS: readonly RegExp[] = [
  /\(\s*isi\s*\)/gi,
  /\bisi\s+marked\b/gi,
  /\bisi\s+mark\b/gi,
  /\bis\s+marked\b/gi,
  /\(\s*ul\s*\)/gi,
  /\bul\s+listed\b/gi,
  /\bfm\s+approved\b/gi,
  /\(\s*fm\s*\)/gi,
  /\bce\b/gi,
];

/** Strip certification noise and leading Make/Brand labels; collapse whitespace. */
export function stripMarkTokens(raw: string): string {
  let s = raw;
  // Leading "Make -", "Make:", "Brand:" labels.
  s = s.replace(/^\s*make\s*[-:]\s*/i, "");
  s = s.replace(/^\s*brand\s*:\s*/i, "");
  for (const re of MARK_TOKEN_PATTERNS) s = s.replace(re, " ");
  // Tidy separators left behind where a mark was removed.
  s = s.replace(/\(\s*\)/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[-,:;/]+|[-,:;/]+$/g, "").trim();
  return s;
}

/**
 * Split a raw make into alternatives on " OR " (case-insensitive), "/" and ",".
 * Returns trimmed, non-empty parts in source order.
 */
export function splitBrandAlternatives(raw: string): string[] {
  return raw
    .split(/\s+or\s+|[/,]/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Normalize a raw make to its canonical brand; returns null when unrecognized. */
export function tryNormalizeBrand(raw: string): string | null {
  const key = stripMarkTokens(raw).toLowerCase().replace(/\s+/g, " ").trim();
  return OBSERVED_BRAND_ALIASES[key] ?? null;
}

/** Pair a raw make with its canonical form (null when unrecognized — never invented). */
export function normalizeBrandOrRaw(raw: string): { raw: string; normalized: string | null } {
  return { raw, normalized: tryNormalizeBrand(raw) };
}
