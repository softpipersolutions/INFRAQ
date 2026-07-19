import ExcelJS from "exceljs";
import type { Cell, Worksheet } from "exceljs";
import type { RawRateKind, XlsxRawLine } from "./types";

/**
 * Deterministic XLSX line extraction for the Phase B ingestion pipeline
 * (PLAN §4.5 step 3 — exceljs branch, as opposed to the Gemini/PDF branch in
 * `pdf-window.ts`). Built directly against the 3 real corpus workbooks (see
 * `test/xlsx.test.ts`), which turn out to use two genuinely different
 * layouts with DIFFERENT COLUMN POSITIONS between files:
 *
 *   - "commercial_bom" (`FF-103 V Agarwal Hotel (09112024 R0).xlsx`, sheet
 *     "BOM"): Sl.No / Description / Indicative Images / Unit / Quantity /
 *     "Unit Price (SITC)" / Amount / Remarks. The make is embedded in the
 *     description ("... ; Make - Jindal (ISI)"), sometimes doubled
 *     ("Make - Make - X"). Section/PART headers and totals rows are full-row
 *     banners where every column repeats the same merged-cell text.
 *
 *   - "dsr_estimate" (`EXTERNAL FIRE FIGHTING ....xlsx` and
 *     `SPRINKLER BUILDING ....xlsx`, sheet "FIRE FIGHTING ESTIMATE"): a
 *     government-DSR-style estimate with THREE parallel amount columns
 *     (S.O.R / D.S.R / M.R. — Amount by rate-schedule source, not by
 *     supply/install scope) at DIFFERENT column indices between the two
 *     files. A numbered item's long specification text lives on its own
 *     row(s); the actual priced sub-item (DSR code, qty, unit, rate) is a
 *     later row in the same block. Section markers are "[A]"/"[B]"-style
 *     tokens in the code column.
 *
 * Because column *positions* differ file-to-file but the column *headers* do
 * not (modulo whitespace/case), every column is located by scanning header
 * text for keywords rather than by fixed index. A sheet whose header cannot
 * be confidently classified contributes no lines — this module never
 * guesses at a layout.
 *
 * Each workbook also carries sheets that are NOT the priced BOQ: take-off
 * calculations, per-floor breakdowns, payment/schedule trackers, and (most
 * dangerously) a "F.F. RATE ANALYSIS" sheet that reuses the same
 * Code/Description/Unit/Qty/Rate/Amount header shape for an *internal
 * cost-buildup* (material + labour cost per unit item) rather than
 * client-facing priced lines. That sheet is excluded by name — it is not a
 * layout this module fails to recognize, it recognizes it and skips it on
 * purpose so its buildup rows don't get mistaken for BOQ lines.
 */

export type XlsxSchemaKind = "commercial_bom" | "dsr_estimate" | "unknown";

export interface ParsedXlsxWorkbook {
  schemaKind: XlsxSchemaKind;
  lines: XlsxRawLine[];
  warnings: string[];
}

/** Internal cost-buildup sheets — recognized on sight, deliberately skipped. */
const SKIP_SHEET_NAME_RE = /rate\s*analysis/i;

/** "Make -" / "Make:" — matched greedily so a doubled "Make - Make - X" still
 *  yields the LAST (innermost) occurrence's remainder as the raw make text. */
const MAKE_LABEL_RE = /make\s*[-:]\s*/gi;

interface ColumnMap {
  kind: XlsxSchemaKind;
  /** "S. No." / "Sl. No." column. */
  slNo: number | null;
  /** DSR-only: the SOR/DSR/E&M code column ("18.1.4", "[A]", "M.R."). */
  code: number | null;
  description: number;
  unit: number;
  qty: number;
  rate: number;
  amounts: {
    /** commercial_bom's single combined "Amount" column. */
    generic: number | null;
    sor: number | null;
    dsr: number | null;
    mr: number | null;
  };
}

/** A formula cell's cached computed value when present, else the raw value. */
function rawCellValue(cell: Cell): unknown {
  const result = (cell as unknown as { result?: unknown }).result;
  return result !== undefined ? result : cell.value;
}

function cellText(cell: Cell): string {
  const v = rawCellValue(cell);
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
    }
    if (typeof obj.text === "string") return obj.text;
  }
  return "";
}

function cellNumber(cell: Cell): number | null {
  const v = rawCellValue(cell);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed.length > 0 && /^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  }
  return null;
}

/** Normalize a header cell's text for keyword matching: lower-case, single-spaced. */
function headerKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function firstNumber(...vals: Array<number | null>): number | null {
  for (const v of vals) {
    if (v !== null) return v;
  }
  return null;
}

/**
 * Scan a worksheet's first rows for a recognizable BOQ header, mapping each
 * role (slNo/description/unit/qty/rate/amount…) to whichever column's own
 * header text matches it — never a hardcoded index.
 */
function findHeader(sheet: Worksheet): { headerRow: number; columns: ColumnMap } | null {
  const maxScan = Math.min(sheet.rowCount, 15);
  const colCount = Math.max(sheet.columnCount, 1);

  for (let r = 1; r <= maxScan; r++) {
    const row = sheet.getRow(r);
    let slNo: number | null = null;
    let description: number | null = null;
    let unit: number | null = null;
    let qty: number | null = null;
    let rate: number | null = null;
    let code: number | null = null;
    let generic: number | null = null;
    let sor: number | null = null;
    let dsr: number | null = null;
    let mr: number | null = null;

    for (let c = 1; c <= colCount; c++) {
      const key = headerKey(cellText(row.getCell(c)));
      if (key.length === 0) continue;

      if (slNo === null && /^s\.?l?\.?\s*no\.?$/.test(key)) {
        slNo = c;
        continue;
      }
      if (description === null && key.includes("description")) {
        description = c;
        continue;
      }
      if (unit === null && key === "unit") {
        unit = c;
        continue;
      }
      if (qty === null && (key.includes("qty") || key.includes("quantity"))) {
        qty = c;
        continue;
      }
      if (rate === null && (key.includes("rate") || key.includes("price"))) {
        rate = c;
        continue;
      }
      if (key.includes("amount")) {
        const compact = key.replace(/[^a-z]/g, "");
        if (dsr === null && compact.includes("dsr")) {
          dsr = c;
          continue;
        }
        if (sor === null && compact.includes("sor")) {
          sor = c;
          continue;
        }
        if (mr === null && compact.includes("mr")) {
          mr = c;
          continue;
        }
        if (generic === null) {
          generic = c;
          continue;
        }
      }
      if (code === null && (key.includes("sor") || key.includes("dsr") || key.includes("e&m") || key === "code")) {
        code = c;
        continue;
      }
    }

    const hasDsrShape =
      (dsr !== null || sor !== null || mr !== null) &&
      description !== null &&
      unit !== null &&
      qty !== null &&
      rate !== null;
    if (hasDsrShape && description !== null && unit !== null && qty !== null && rate !== null) {
      return {
        headerRow: r,
        columns: {
          kind: "dsr_estimate",
          slNo,
          code,
          description,
          unit,
          qty,
          rate,
          amounts: { generic: null, sor, dsr, mr },
        },
      };
    }

    const hasBomShape =
      slNo !== null && description !== null && unit !== null && qty !== null && rate !== null && generic !== null;
    if (hasBomShape && slNo !== null && description !== null && unit !== null && qty !== null && rate !== null) {
      return {
        headerRow: r,
        columns: {
          kind: "commercial_bom",
          slNo,
          code: null,
          description,
          unit,
          qty,
          rate,
          amounts: { generic, sor: null, dsr: null, mr: null },
        },
      };
    }
  }
  return null;
}

/** Raw make text after the LAST "Make -"/"Make:" label in a description, if any. */
function extractMakeRaw(description: string): string | null {
  let lastEnd = -1;
  const re = new RegExp(MAKE_LABEL_RE.source, MAKE_LABEL_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(description)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd === -1) return null;
  const rest = description.slice(lastEnd);
  const stopIdx = rest.search(/[;\n]/);
  const raw = (stopIdx === -1 ? rest : rest.slice(0, stopIdx)).trim();
  return raw.length > 0 ? raw : null;
}

/** Section marker rows in the DSR layout: a bracketed code, e.g. "[A]". */
const SECTION_MARKER_RE = /^\[.+\]$/;

function parseCommercialBomRows(
  sheet: Worksheet,
  headerRow: number,
  cols: ColumnMap,
): XlsxRawLine[] {
  const lines: XlsxRawLine[] = [];
  let currentSection: string | null = null;

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const slNoText = cellText(row.getCell(cols.slNo ?? 1)).trim();
    const descText = cellText(row.getCell(cols.description)).trim();
    const unitText = cellText(row.getCell(cols.unit))
      .replace(/\s+/g, " ")
      .trim();
    const qty = cellNumber(row.getCell(cols.qty));
    const rate = cellNumber(row.getCell(cols.rate));
    const amount = cols.amounts.generic !== null ? cellNumber(row.getCell(cols.amounts.generic)) : null;

    const isDataLine = qty !== null && unitText.length > 0 && descText.length > 0;
    if (isDataLine) {
      lines.push({
        slNo: slNoText.length > 0 ? slNoText : null,
        description: descText,
        makeRaw: extractMakeRaw(descText),
        qty,
        unitRaw: unitText,
        unitRateRupees: rate,
        rateKind: "SITC",
        amountRupees: amount,
        section: currentSection,
        page: 0,
        confidence: 1,
        locator: { sheet: sheet.name, row: r },
      });
      continue;
    }

    // A full-row banner (PART/section title, or a "... TOTAL:" recap row)
    // replicates the same text across the Sl.No and Description columns
    // (a side effect of the source's merged cells).
    if (slNoText.length > 0 && descText.length > 0 && slNoText === descText) {
      currentSection = descText.replace(/:\s*$/, "").trim();
    }
  }
  return lines;
}

function parseDsrEstimateRows(sheet: Worksheet, headerRow: number, cols: ColumnMap): XlsxRawLine[] {
  const lines: XlsxRawLine[] = [];
  let currentSection: string | null = null;

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const slNoText = cols.slNo !== null ? cellText(row.getCell(cols.slNo)).trim() : "";
    const codeText = cols.code !== null ? cellText(row.getCell(cols.code)).trim() : "";
    const descText = cellText(row.getCell(cols.description)).trim();
    const unitText = cellText(row.getCell(cols.unit))
      .replace(/\s+/g, " ")
      .trim();
    const qty = cellNumber(row.getCell(cols.qty));
    const rate = cellNumber(row.getCell(cols.rate));
    const sorAmt = cols.amounts.sor !== null ? cellNumber(row.getCell(cols.amounts.sor)) : null;
    const dsrAmt = cols.amounts.dsr !== null ? cellNumber(row.getCell(cols.amounts.dsr)) : null;
    const mrAmt = cols.amounts.mr !== null ? cellNumber(row.getCell(cols.amounts.mr)) : null;

    const isDataLine = qty !== null && unitText.length > 0 && descText.length > 0;
    if (isDataLine) {
      const slNo = codeText.length > 0 ? codeText : slNoText.length > 0 ? slNoText : null;
      lines.push({
        slNo,
        description: descText,
        makeRaw: extractMakeRaw(descText),
        qty,
        unitRaw: unitText,
        unitRateRupees: rate,
        // DSR/SOR/MR label which *rate schedule* an amount came from, not
        // supply/install scope — that axis isn't recoverable from the sheet,
        // so every dsr_estimate line defaults to SITC, matching the near-
        // universal "Supplying, installation, testing and commissioning"
        // wording of the item descriptions in this corpus.
        rateKind: "SITC",
        amountRupees: firstNumber(dsrAmt, sorAmt, mrAmt),
        section: currentSection,
        page: 0,
        confidence: 1,
        locator: { sheet: sheet.name, row: r },
      });
      continue;
    }

    if (SECTION_MARKER_RE.test(codeText) && descText.length > 0) {
      currentSection = descText;
    }
  }
  return lines;
}

/** Parse one XLSX workbook's buffer into a sniffed schema kind and its lines. */
export async function parseXlsxWorkbook(bytes: Buffer): Promise<ParsedXlsxWorkbook> {
  const warnings: string[] = [];
  const wb = new ExcelJS.Workbook();
  // Cast around a duplicate-`@types/node` Buffer identity mismatch between
  // this package's Buffer and exceljs's declared param type (same pattern as
  // packages/documents/test/excel.test.ts).
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);

  const lines: XlsxRawLine[] = [];
  let schemaKind: XlsxSchemaKind = "unknown";

  for (const sheet of wb.worksheets) {
    if (SKIP_SHEET_NAME_RE.test(sheet.name)) {
      warnings.push(`skipped internal cost-buildup sheet "${sheet.name}"`);
      continue;
    }
    const header = findHeader(sheet);
    if (!header) continue;

    const sheetLines =
      header.columns.kind === "commercial_bom"
        ? parseCommercialBomRows(sheet, header.headerRow, header.columns)
        : parseDsrEstimateRows(sheet, header.headerRow, header.columns);

    if (sheetLines.length === 0) {
      warnings.push(`sheet "${sheet.name}" matched a ${header.columns.kind} header but yielded no lines`);
      continue;
    }

    if (schemaKind === "unknown") {
      schemaKind = header.columns.kind;
    } else if (schemaKind !== header.columns.kind) {
      warnings.push(
        `workbook mixes schema kinds ("${schemaKind}" and "${header.columns.kind}" on sheet "${sheet.name}") — keeping "${schemaKind}"`,
      );
      continue;
    }
    lines.push(...sheetLines);
  }

  if (schemaKind === "unknown" && lines.length === 0) {
    warnings.push("no recognized BOQ header found in any worksheet");
  }

  return { schemaKind, lines, warnings };
}

export type { RawRateKind };
