/**
 * Prompt builders for the Phase B Gemini extraction lane (WP1, spec section
 * E). Pure, deterministic string builders — same input always produces the
 * same output, so they are cheap to snapshot-test and never touch a model
 * themselves (mirrors the house style in ../prompts.ts and ../extract.ts).
 *
 * PDF_EXTRACT_PROMPT_VERSION is stamped onto every extraction_runs row it
 * produces. Bump it on EVERY change to either prompt below (wording,
 * instructions, field list) so a run can always be traced back to the exact
 * prompt that produced it, and the eval harness can gate a version bump on
 * precision/recall before it ships.
 */
export const PDF_EXTRACT_PROMPT_VERSION = "pdf-extract-v1";

export interface DocMetaHints {
  filename: string;
  /** A file/job reference parsed from the filename convention (e.g. "FF-149"), if any. */
  parsedFileRef?: string | null;
  /** A date parsed from the filename, offered only as a fallback for docDateISO. */
  parsedDateISO?: string | null;
  /** A revision parsed from the filename, offered only as a fallback for revision. */
  parsedRevision?: string | null;
}

/** Build the whole-document metadata prompt (paired with docMetaSchema). */
export function buildDocMetaPrompt(hints: DocMetaHints): string {
  return [
    "You are reading a historical fire-safety proposal/estimate/rate-list document (PDF) for Greenberg Enterprises' Pebble ingestion pipeline.",
    "Read the ENTIRE document before answering — metadata often sits on a later page (a revision box, a totals/summary sheet, a signature block) even when the letterhead is on page 1.",
    "",
    "Extract:",
    "- clientName: the client company/person the document is addressed to (NOT the letterhead entity that issued it).",
    "- projectName: the project or site name.",
    "- attention: the 'Attention' / 'Kind Attn' / 'To' contact person, if printed.",
    "- docDateISO: the document's own printed date, formatted YYYY-MM-DD. PREFER the printed date over the filename hints below — the filename is a fallback ONLY when no date is printed anywhere in the document.",
    "- revision: the printed revision/version label (e.g. 'R2', 'Rev 02'), transcribed exactly as printed, or null if the document shows none.",
    "- sourceEntityGuess: the letterhead / issuing entity. This is usually 'Greenberg Enterprises' or 'Sample Traders', but transcribe exactly what is printed if it is some other name.",
    "- docKind: classify as exactly one of \"proposal\" | \"rate_list\" | \"estimate\" | \"other\".",
    "- systemsMentioned: every fire-safety system named anywhere in the document, as free text (e.g. 'Fire Alarm System', 'Sprinkler', 'Hydrant').",
    "- sections: every PART / section heading you see (e.g. 'PART I. SPRINKLER SYSTEM'), each with your best-guess canonical system — one of FAS, Hydrant, Sprinkler, Extinguisher, Suppression — or null if you cannot tell.",
    "- grandTotalRupees: the grand/final total in rupees EXACTLY as printed (e.g. the 'Total with GST' or final figure), or null if no total is printed anywhere.",
    "- gstMentioned: true if GST/tax is mentioned anywhere (a line item, a note, 'GST extra', 'GST @ 18%'); false if the document is explicit that there is none; null if tax is not discussed at all.",
    "- summary: a factual summary of what this document is and what it covers, in 250 words or fewer.",
    "",
    "CRITICAL: transcribe every number EXACTLY as printed in the source. Never compute, round, sum, or otherwise derive a number that is not itself printed — if you are not certain a figure appears verbatim, leave the field null. Downstream code, not you, verifies and cross-checks every number.",
    "",
    "Filename (context only — do not treat as ground truth over the printed content):",
    `  ${hints.filename}`,
    hints.parsedFileRef ? `Filename-derived reference: ${hints.parsedFileRef}` : null,
    hints.parsedDateISO ? `Filename-derived date (fallback only, use the printed date if one exists): ${hints.parsedDateISO}` : null,
    hints.parsedRevision ? `Filename-derived revision (fallback only, use the printed revision if one exists): ${hints.parsedRevision}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export interface PageWindowArgs {
  /** Absolute 1-based printed page number this window starts at. */
  pageStart: number;
  /** Absolute 1-based printed page number this window ends at (inclusive). */
  pageEnd: number;
  /** Section headings already seen in earlier windows, for continuity across window boundaries. */
  sectionContext: string[];
}

/** Build the page-windowed line-extraction prompt (paired with pageLinesSchema). */
export function buildPageWindowPrompt(args: PageWindowArgs): string {
  return [
    `You are reading pages ${args.pageStart}-${args.pageEnd} of a fire-safety BOQ/proposal document (ABSOLUTE page numbering, exactly as printed in the full document — page ${args.pageStart} is the first page in this excerpt).`,
    "Extract every BOQ line-item row visible in this page range as `lines`, plus any Terms & Conditions text you see in this range as `termsText` (null if none).",
    "",
    "For each line item:",
    "- page: the ABSOLUTE printed page number the row appears on (within the range above), 1-based.",
    "- slNo: the row's serial/item number exactly as printed (e.g. 'A1', '1.2'), or null if none is printed.",
    "- description: the item description transcribed VERBATIM — do not paraphrase, correct spelling, expand abbreviations, or drop wording.",
    "- makeRaw: the make/brand ONLY if it is actually printed — either inline within the description text or in a dedicated Make column. Transcribe exactly, including 'OR' alternatives (e.g. 'Agni OR Ravel') and certification suffixes. Null if no make is printed for that row.",
    "- qty, unitRaw, unitRateRupees, amountRupees: transcribe exactly as printed; null for any column that is blank or absent for that row. Never calculate a missing value from the others — if the amount is blank, leave amountRupees null even if qty and rate are both present.",
    "- rateKind: classify from the column headers over the rate you are reading — \"SITC\" when the header reads something like 'Unit Price (SITC)' or 'Rate (Supply + Install)'; \"SUPPLY\" or \"INSTALL\" when supply and installation are printed as separate columns and this row's rate is one of them; \"UNKNOWN\" when the headers don't tell you.",
    "- section: the current PART / section heading this row falls under — carry forward the most recent heading printed above it in this window (or from sectionContext below if the window starts mid-section). Null if there is truly no heading.",
    "- confidence: your own confidence in [0,1] that this row was read correctly.",
    "",
    "Never invent a row. Skip: letterhead/header text, column-header rows, subtotal rows, grand-total rows, and GST/tax rollup rows — a subtotal or total row is NOT a line item.",
    "",
    args.sectionContext.length > 0
      ? `Section headings already seen before this window (for continuity — the first rows in this window may continue one of these): ${args.sectionContext.join(", ")}`
      : "This window starts at the beginning of the document — there is no prior section context.",
  ].join("\n");
}
