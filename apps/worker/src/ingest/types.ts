import type { SystemType, UnitOfMeasure } from "@pebble/shared";

/**
 * Shared shapes for the deterministic half of Phase B ingestion (WP2):
 * filename parsing, PDF windowing, XLSX parsing, normalization and chunk
 * building. The LLM-extraction lane (`packages/ai`, a parallel work stream)
 * is expected to land an `ExtractedLine` type in `packages/ai/src/ingest/schemas.ts`
 * that is STRUCTURALLY COMPATIBLE with `RawLine` below — both describe one
 * candidate BOQ row pulled out of a source document page/window, before any
 * normalization or brand/unit canonicalization has been applied. Whichever
 * lands first is the reference shape; this file does not import from
 * `@pebble/ai` (and must not — that package is a parallel lane and may not
 * exist yet), so `RawLine` is declared locally and kept in lockstep by
 * convention/code review rather than a shared import.
 */

/** Kind of rate a raw extracted line represents, before normalization. */
export type RawRateKind = "SITC" | "SUPPLY" | "INSTALL" | "UNKNOWN";

/**
 * One row pulled from a source document — a PDF page window (via the LLM
 * lane) or an XLSX sheet (via `parseXlsxWorkbook`, deterministic). Every
 * field the extractor could not confidently read is `null`, never guessed.
 */
export interface RawLine {
  /** Printed Sl. No. / item code from the source, verbatim (e.g. "A1", "18.1.4"). */
  slNo: string | null;
  /** The item description as printed (may embed the make — see normalize.ts). */
  description: string;
  /** Raw make/brand text as printed, before brand alias resolution. */
  makeRaw: string | null;
  /** Quantity as printed; null when absent or unparsable. */
  qty: number | null;
  /** Raw unit token as printed (e.g. "mtr", "Nos", "Set"), before normalization. */
  unitRaw: string | null;
  /** Unit rate in rupees as printed; null when absent or unparsable. */
  unitRateRupees: number | null;
  /** What kind of rate `unitRateRupees` represents. */
  rateKind: RawRateKind;
  /** Line amount in rupees as printed (qty × rate, or a document-supplied total); null when absent. */
  amountRupees: number | null;
  /** Section / PART heading this line was found under, if any. */
  section: string | null;
  /** 1-based absolute page number the line was read from. 0 for XLSX sources (see `locator`). */
  page: number;
  /** Extraction confidence in [0, 1] — 1.0 for deterministic XLSX reads. */
  confidence: number;
}

/**
 * Sheet + row locator for a `RawLine` sourced from an XLSX workbook —
 * carried alongside (not instead of) `page` (which is 0 for XLSX lines) so a
 * reviewer can jump back to the exact cell. Structurally compatible with the
 * `sheet`/`row` fields of `@pebble/shared`'s `SourceLocator`, but kept as its
 * own local type here since `SourceLocator.page` is a positive int and XLSX
 * lines report `page: 0`.
 */
export interface XlsxLocator {
  sheet: string;
  row: number;
}

/** A `RawLine` sourced from an XLSX workbook, carrying its sheet/row locator. */
export interface XlsxRawLine extends RawLine {
  locator: XlsxLocator;
}

export type { SystemType, UnitOfMeasure };
