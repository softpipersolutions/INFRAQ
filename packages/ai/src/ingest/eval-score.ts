import type { DocMeta, ExtractedLine } from "./schemas";

/**
 * Pure scoring for the AI extraction eval harness (eval/run-extraction-eval.ts,
 * spec section E "AI eval harness"). No I/O, no model calls — just comparing
 * a hand-labeled expectation against what extractDocMeta/extractPageWindow
 * actually produced, so this is trivially unit-testable.
 */

/** One hand-labeled expected BOQ line item. */
export interface ExpectedLine {
  /** Absolute printed page number the row is on. */
  page: number;
  slNo?: string | null;
  /** A substring (case/whitespace-insensitive) the actual description must contain. */
  descriptionContains: string;
  makeRaw?: string | null;
  qty?: number | null;
  unitRaw?: string | null;
  unitRateRupees?: number | null;
  amountRupees?: number | null;
  rateKind?: string;
  section?: string | null;
}

/** Hand labels for one source document. */
export interface EvalExpectation {
  /** Pages the labeler actually reviewed — precision is only scored on lines from these pages. */
  labeledPages: number[];
  expectedLines: ExpectedLine[];
  expectMeta?: Partial<DocMeta>;
}

export interface FieldAccuracy {
  make: number;
  unit: number;
  rateKind: number;
}

export interface ScoreResult {
  precision: number;
  recall: number;
  matched: number;
  expectedCount: number;
  /** How many extracted lines fell on a labeled page (the precision denominator). */
  extractedOnLabeledPages: number;
  fieldAccuracy: FieldAccuracy;
  metaAccuracy: Record<string, boolean>;
  mismatches: string[];
}

function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

const RATE_TOLERANCE_FRACTION = 0.005; // 0.5%

/**
 * Does `actual` satisfy `expected`? Only checks the fields the harness
 * considers load-bearing for identifying "this is the row I labeled": page,
 * qty (exact, when expected), rate (within 0.5%, when expected), and a
 * description substring match. make/unit/rateKind are scored separately as
 * field accuracy — a mismatch there does not fail the line match.
 */
export function matchLine(expected: ExpectedLine, actual: ExtractedLine): boolean {
  if (actual.page !== expected.page) return false;

  if (expected.qty !== undefined && expected.qty !== null) {
    if (actual.qty !== expected.qty) return false;
  }

  if (expected.unitRateRupees !== undefined && expected.unitRateRupees !== null) {
    if (actual.unitRateRupees === null) return false;
    const tolerance = Math.abs(expected.unitRateRupees) * RATE_TOLERANCE_FRACTION;
    if (Math.abs(actual.unitRateRupees - expected.unitRateRupees) > tolerance) return false;
  }

  const actualDescription = normalizeWhitespace(actual.description).toLowerCase();
  const expectedSubstring = normalizeWhitespace(expected.descriptionContains).toLowerCase();
  if (!actualDescription.includes(expectedSubstring)) return false;

  return true;
}

function normalizeField(value: string | null | undefined): string {
  return normalizeWhitespace(value ?? "").toLowerCase();
}

function metaFieldMatches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string" && typeof actual === "string") {
    return normalizeField(expected) === normalizeField(actual);
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/**
 * Score one document's extraction against its hand labels.
 *
 * Matching is greedy 1:1: each expected line claims the first not-yet-used
 * actual line (restricted to lines on labeledPages) that satisfies
 * matchLine. Precision is scored only over lines on labeledPages (an
 * unlabeled page's extra lines are neither rewarded nor punished); recall is
 * scored over every expected line.
 */
export function scoreExtraction(
  expectation: EvalExpectation,
  actual: { meta: DocMeta | null; lines: ExtractedLine[] },
): ScoreResult {
  const mismatches: string[] = [];
  const labeledPages = new Set(expectation.labeledPages);
  const linesOnLabeledPages = actual.lines.filter((l) => labeledPages.has(l.page));

  const usedActual = new Set<number>();
  let matched = 0;
  let makeChecked = 0;
  let makeCorrect = 0;
  let unitChecked = 0;
  let unitCorrect = 0;
  let rateKindChecked = 0;
  let rateKindCorrect = 0;

  for (const expected of expectation.expectedLines) {
    let matchIdx = -1;
    for (let i = 0; i < linesOnLabeledPages.length; i++) {
      if (usedActual.has(i)) continue;
      if (matchLine(expected, linesOnLabeledPages[i]!)) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx === -1) {
      mismatches.push(
        `missing: page ${expected.page} "${expected.descriptionContains}" not found among extracted lines`,
      );
      continue;
    }

    usedActual.add(matchIdx);
    matched += 1;
    const actualLine = linesOnLabeledPages[matchIdx]!;

    if (expected.makeRaw !== undefined) {
      makeChecked += 1;
      if (normalizeField(expected.makeRaw) === normalizeField(actualLine.makeRaw)) {
        makeCorrect += 1;
      } else {
        mismatches.push(
          `make mismatch page ${expected.page} "${expected.descriptionContains}": expected "${expected.makeRaw}" got "${actualLine.makeRaw}"`,
        );
      }
    }

    if (expected.unitRaw !== undefined) {
      unitChecked += 1;
      if (normalizeField(expected.unitRaw) === normalizeField(actualLine.unitRaw)) {
        unitCorrect += 1;
      } else {
        mismatches.push(
          `unit mismatch page ${expected.page} "${expected.descriptionContains}": expected "${expected.unitRaw}" got "${actualLine.unitRaw}"`,
        );
      }
    }

    if (expected.rateKind !== undefined) {
      rateKindChecked += 1;
      if (expected.rateKind === actualLine.rateKind) {
        rateKindCorrect += 1;
      } else {
        mismatches.push(
          `rateKind mismatch page ${expected.page} "${expected.descriptionContains}": expected "${expected.rateKind}" got "${actualLine.rateKind}"`,
        );
      }
    }
  }

  for (let i = 0; i < linesOnLabeledPages.length; i++) {
    if (usedActual.has(i)) continue;
    const extra = linesOnLabeledPages[i]!;
    mismatches.push(`extra: page ${extra.page} "${extra.description}" was extracted but not expected`);
  }

  const expectedCount = expectation.expectedLines.length;
  const extractedOnLabeledPages = linesOnLabeledPages.length;
  const precision =
    extractedOnLabeledPages === 0 ? (expectedCount === 0 ? 1 : 0) : matched / extractedOnLabeledPages;
  const recall = expectedCount === 0 ? 1 : matched / expectedCount;

  const metaAccuracy: Record<string, boolean> = {};
  if (expectation.expectMeta) {
    for (const key of Object.keys(expectation.expectMeta) as Array<keyof DocMeta>) {
      const expectedValue = expectation.expectMeta[key];
      const actualValue = actual.meta ? actual.meta[key] : undefined;
      const ok = actual.meta !== null && metaFieldMatches(expectedValue, actualValue);
      metaAccuracy[key] = ok;
      if (!ok) {
        mismatches.push(`meta.${key} mismatch: expected ${JSON.stringify(expectedValue)} got ${JSON.stringify(actualValue)}`);
      }
    }
  }

  return {
    precision,
    recall,
    matched,
    expectedCount,
    extractedOnLabeledPages,
    fieldAccuracy: {
      make: makeChecked === 0 ? 1 : makeCorrect / makeChecked,
      unit: unitChecked === 0 ? 1 : unitCorrect / unitChecked,
      rateKind: rateKindChecked === 0 ? 1 : rateKindCorrect / rateKindChecked,
    },
    metaAccuracy,
    mismatches,
  };
}
