/**
 * Filename parsing for the Phase B historical corpus
 * ("proposal-corpus/" at the repo root — 142 PDF + 3 XLSX).
 *
 * Four accumulated years of ad hoc naming means there is no single
 * "canonical" shape: this parser was built by enumerating the *actual* 145
 * filenames (see `test/fixtures/corpus-filenames.json`, a snapshot of
 * `readdirSync` over the corpus dir) rather than guessing at a convention.
 * Observed variants:
 *   - Canonical: `FF-01 Contoso Plaza - SITC Active Fire Fighting (21092022 R0).pdf`
 *   - Sub-numbers: `FF-05-1 ... .pdf` (fileRef "FF-05", subRef "1")
 *   - Letter suffixes via hyphen: `FF-126-B ... 28042025 R1.pdf` (date/rev OUTSIDE parens)
 *   - Letter suffixes via parens: `FF-30(L) ... - Labour Charges.pdf`
 *   - No hyphen: `FF01 ...`, `FF57 ...` (normalized to "FF-01"/"FF-57")
 *   - GBE prefix, with a supply/labour split: `GBE-71 ... - Supply Only.pdf`
 *   - Non-numeric ref: `GBE-Contoso-BOQ (22072025 R2).pdf`
 *   - No id/date/rev at all: `FFS for A3 plot (Fabrikam) - Estimate ....pdf`
 *   - Malformed 7-digit date: `(1702025 R0)` — a digit was dropped upstream
 *   - Invalid calendar date: `(31022026 R0)` — Feb 31 does not exist
 *
 * Parsing never throws. Anything not confidently extracted comes back null
 * with a warning, to be resolved by the doc-meta LLM pass later in the
 * pipeline (PLAN §4.5 step 2) rather than guessed here.
 */

export type CorpusDocType = "pdf" | "xlsx" | "other";
export type CorpusSplitKind = "supply_only" | "labour_charges" | null;

export interface ParsedCorpusFilename {
  fileRef: string | null;
  subRef: string | null;
  suffix: string | null;
  docDate: Date | null;
  revision: string | null;
  title: string;
  docType: CorpusDocType;
  splitKind: CorpusSplitKind;
  warnings: string[];
}

// ─── Reference-id patterns, tried most-specific-first ──────────────────────
// (a plainer pattern would otherwise short-match "FF-05" inside "FF-05-1").

/** `FF-05-1`, `FF-33-05` — a numeric sub-reference after a second hyphen. */
const REF_SUBNUM_RE = /^(FF|GBE)-(\d+)-(\d+)\b/;
/** `FF-126-B` — a single-letter suffix after a second hyphen. */
const REF_SUFFIX_HYPHEN_RE = /^(FF|GBE)-(\d+)-([A-Za-z])\b/;
/** `FF-30(L)` — a single-letter suffix in parens, no separating space. */
const REF_SUFFIX_PAREN_RE = /^(FF|GBE)-(\d+)\(([A-Za-z])\)/;
/** `FF-01`, `GBE-77` — the plain, most common case. */
const REF_PLAIN_RE = /^(FF|GBE)-(\d+)\b/;
/** `FF01`, `FF57` — missing the hyphen; normalized on the way out. */
const REF_NO_HYPHEN_RE = /^(FF)(\d+)\b/;
/** `GBE-Contoso` — a non-numeric reference token. */
const REF_NONNUMERIC_RE = /^(FF|GBE)-([A-Za-z]+)\b/;

// ─── Date + revision patterns ───────────────────────────────────────────────

/** `(21092022 R0)`, `(1702025 R0)` (malformed), `(26022025)` (no revision). */
const DATE_PAREN_RE = /\((\d{7,8})\s*(R\d+)?\)/;
/** `28042025 R1` with no surrounding parens at all (e.g. FF-122, FF-126). */
const DATE_BARE_RE = /(\d{7,8})\s+(R\d+)\b/;

const SUPPLY_ONLY_RE = /[-–—]?\s*supply\s*only/i;
const LABOUR_CHARGES_RE = /[-–—]?\s*labou?r\s*charges/i;

function docTypeFromExt(ext: string): CorpusDocType {
  const e = ext.toLowerCase();
  if (e === ".pdf") return "pdf";
  if (e === ".xlsx") return "xlsx";
  return "other";
}

function splitExt(filename: string): { stem: string; ext: string } {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return { stem: filename, ext: "" };
  return { stem: filename.slice(0, idx), ext: filename.slice(idx) };
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Parse a DDMMYYYY (or malformed 7-digit) date token pulled from a filename. */
function parseDdmmyyyy(digits: string): { date: Date | null; warning: string | null } {
  if (digits.length !== 8) {
    return {
      date: null,
      warning: `malformed date "${digits}" in filename (expected 8 digits DDMMYYYY)`,
    };
  }
  const day = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const year = Number(digits.slice(4, 8));
  if (!isValidYmd(year, month, day)) {
    return {
      date: null,
      warning: `invalid date "${digits}" in filename (day/month out of range)`,
    };
  }
  return { date: new Date(Date.UTC(year, month - 1, day)), warning: null };
}

interface RefMatch {
  fileRef: string;
  subRef: string | null;
  suffix: string | null;
  matched: string;
  warning: string | null;
}

/** Try each reference pattern in specificity order; first match wins. */
function matchFileRef(stem: string): RefMatch | null {
  const subnum = REF_SUBNUM_RE.exec(stem);
  if (subnum) {
    return {
      fileRef: `${subnum[1] ?? ""}-${subnum[2] ?? ""}`,
      subRef: subnum[3] ?? null,
      suffix: null,
      matched: subnum[0] ?? "",
      warning: null,
    };
  }
  const suffixHyphen = REF_SUFFIX_HYPHEN_RE.exec(stem);
  if (suffixHyphen) {
    return {
      fileRef: `${suffixHyphen[1] ?? ""}-${suffixHyphen[2] ?? ""}`,
      subRef: null,
      suffix: suffixHyphen[3] ?? null,
      matched: suffixHyphen[0] ?? "",
      warning: null,
    };
  }
  const suffixParen = REF_SUFFIX_PAREN_RE.exec(stem);
  if (suffixParen) {
    return {
      fileRef: `${suffixParen[1] ?? ""}-${suffixParen[2] ?? ""}`,
      subRef: null,
      suffix: suffixParen[3] ?? null,
      matched: suffixParen[0] ?? "",
      warning: null,
    };
  }
  const plain = REF_PLAIN_RE.exec(stem);
  if (plain) {
    return {
      fileRef: `${plain[1] ?? ""}-${plain[2] ?? ""}`,
      subRef: null,
      suffix: null,
      matched: plain[0] ?? "",
      warning: null,
    };
  }
  const noHyphen = REF_NO_HYPHEN_RE.exec(stem);
  if (noHyphen) {
    const normalized = `${noHyphen[1] ?? ""}-${noHyphen[2] ?? ""}`;
    return {
      fileRef: normalized,
      subRef: null,
      suffix: null,
      matched: noHyphen[0] ?? "",
      warning: `normalized no-hyphen file reference "${noHyphen[0] ?? ""}" to "${normalized}"`,
    };
  }
  const nonNumeric = REF_NONNUMERIC_RE.exec(stem);
  if (nonNumeric) {
    return {
      fileRef: `${nonNumeric[1] ?? ""}-${nonNumeric[2] ?? ""}`,
      subRef: null,
      suffix: null,
      matched: nonNumeric[0] ?? "",
      warning: null,
    };
  }
  return null;
}

/** Collapse whitespace/underscores and strip leftover separators. */
function cleanTitle(raw: string): string {
  let s = raw.replace(/_/g, " ");
  s = s.replace(/\s+/g, " ");
  s = s.replace(/^[\s\-–—:,;]+/, "").replace(/[\s\-–—:,;]+$/, "");
  s = s.trim();
  return s;
}

export function parseCorpusFilename(filename: string): ParsedCorpusFilename {
  const warnings: string[] = [];
  const { stem, ext } = splitExt(filename);
  const docType = docTypeFromExt(ext);

  const refMatch = matchFileRef(stem);
  let fileRef: string | null = null;
  let subRef: string | null = null;
  let suffix: string | null = null;
  let working = stem;
  if (refMatch) {
    fileRef = refMatch.fileRef;
    subRef = refMatch.subRef;
    suffix = refMatch.suffix;
    if (refMatch.warning) warnings.push(refMatch.warning);
    working = working.slice(refMatch.matched.length);
  } else {
    warnings.push(`no file reference id found in filename "${filename}"`);
  }

  let docDate: Date | null = null;
  let revision: string | null = null;
  let dateMatchedText: string | null = null;

  const parenMatch = DATE_PAREN_RE.exec(stem);
  if (parenMatch) {
    dateMatchedText = parenMatch[0] ?? null;
    const parsed = parseDdmmyyyy(parenMatch[1] ?? "");
    docDate = parsed.date;
    if (parsed.warning) warnings.push(parsed.warning);
    revision = parenMatch[2] ?? null;
  } else {
    const bareMatch = DATE_BARE_RE.exec(stem);
    if (bareMatch) {
      dateMatchedText = bareMatch[0] ?? null;
      const parsed = parseDdmmyyyy(bareMatch[1] ?? "");
      docDate = parsed.date;
      if (parsed.warning) warnings.push(parsed.warning);
      revision = bareMatch[2] ?? null;
    }
  }

  let splitKind: CorpusSplitKind = null;
  if (SUPPLY_ONLY_RE.test(stem)) splitKind = "supply_only";
  else if (LABOUR_CHARGES_RE.test(stem)) splitKind = "labour_charges";

  if (dateMatchedText) working = working.split(dateMatchedText).join("");
  working = working.replace(SUPPLY_ONLY_RE, "").replace(LABOUR_CHARGES_RE, "");
  const title = cleanTitle(working) || cleanTitle(stem);

  return { fileRef, subRef, suffix, docDate, revision, title, docType, splitKind, warnings };
}

/**
 * Historical corpus entity attribution (per corpus analysis): proposals dated
 * within calendar-year 2023 were issued under Sample Traders; every
 * other dated proposal, under Greenberg Enterprises. Undated documents carry
 * no attribution here — that is resolved by the doc-meta pass.
 */
export function sourceEntityForDate(
  d: Date | null,
): "Sample Traders" | "Greenberg Enterprises" | null {
  if (d === null) return null;
  return d.getUTCFullYear() === 2023 ? "Sample Traders" : "Greenberg Enterprises";
}
