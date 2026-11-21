import { STAGED_RATE_KINDS } from "@pebble/shared";
import { z } from "zod";

/**
 * Zod schemas for the Phase B Gemini extraction lane (WP1) — two passes over
 * a source PDF:
 *   - docMetaSchema: one whole-document metadata pass (client/project/dates/
 *     sections/grand-total/summary).
 *   - pageLinesSchema: a page-windowed BOQ line-item pass.
 *
 * House principle (spec section E): the MODEL only READS numbers off the
 * page and transcribes them — it never computes, sums, rounds or infers a
 * number it did not see printed. All arithmetic verification (qty × rate ≈
 * amount cross-checks), unit/brand canonicalization and dedup happen in
 * deterministic CODE downstream (packages/shared normalization + the
 * ingestion worker), never here. These schemas therefore carry RAW strings
 * and printed numbers as-is, with nulls where a document is silent — never a
 * derived or guessed value dressed up as a fact.
 *
 * rateKind reuses @pebble/shared's STAGED_RATE_KINDS so a staged payload can
 * be assembled from an ExtractedLine without a re-mapping step.
 */

/** How the model classifies the overall kind of document it read. */
export const DOC_KINDS = ["proposal", "rate_list", "estimate", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const docSectionSchema = z.object({
  title: z.string().min(1),
  /** Best-guess canonical system for this section — FAS/Hydrant/Sprinkler/Extinguisher/Suppression, or null if unclear. */
  systemGuess: z.string().nullable(),
});

/**
 * Whole-document metadata — one generateObject call over the full PDF.
 * Every field is either a printed value (transcribed exactly) or null.
 */
export const docMetaSchema = z.object({
  clientName: z.string().nullable(),
  projectName: z.string().nullable(),
  attention: z.string().nullable(),
  /** Printed document date, formatted YYYY-MM-DD. Null if no date is printed. */
  docDateISO: z.string().regex(ISO_DATE_RE, "docDateISO must be YYYY-MM-DD").nullable(),
  revision: z.string().nullable(),
  /** Letterhead / issuing entity, e.g. "Greenberg Enterprises", "Sample Traders". */
  sourceEntityGuess: z.string().nullable(),
  docKind: z.enum(DOC_KINDS),
  /** Every fire-safety system named anywhere in the document, free text. */
  systemsMentioned: z.array(z.string()),
  /** Every PART / section heading, each with a best-guess canonical system. */
  sections: z.array(docSectionSchema),
  /** Grand/final total in rupees, EXACTLY as printed. Null if no total is printed. */
  grandTotalRupees: z.number().nullable(),
  gstMentioned: z.boolean().nullable(),
  summary: z
    .string()
    .min(1)
    .describe("A factual summary of what this document is and covers, in 250 words or fewer."),
});
export type DocMeta = z.infer<typeof docMetaSchema>;

/** One BOQ line-item row, transcribed from a page window. */
export const extractedLineSchema = z.object({
  slNo: z.string().nullable(),
  description: z.string().min(1),
  /** Make/brand ONLY if actually printed (inline in the description or a Make column). */
  makeRaw: z.string().nullable(),
  qty: z.number().nullable(),
  unitRaw: z.string().nullable(),
  unitRateRupees: z.number().nullable(),
  /** Classified from the column headers over the rate; UNKNOWN when the headers don't say. */
  rateKind: z.enum(STAGED_RATE_KINDS),
  amountRupees: z.number().nullable(),
  /** The current PART / section heading this row falls under, carried forward. */
  section: z.string().nullable(),
  /** Absolute 1-based printed page number the row appears on. */
  page: z.number().int().positive(),
  /** Model's own confidence that this row was read correctly, in [0,1]. */
  confidence: z.number().min(0).max(1),
});
export type ExtractedLine = z.infer<typeof extractedLineSchema>;

/** The result of one page-windowed extraction pass. */
export const pageLinesSchema = z.object({
  lines: z.array(extractedLineSchema),
  /** Terms & Conditions text seen in this window, or null if none. */
  termsText: z.string().nullable(),
});
export type PageLines = z.infer<typeof pageLinesSchema>;
