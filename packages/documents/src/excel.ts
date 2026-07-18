import { GST_RATE, paiseToRupees } from "@pebble/shared";
import ExcelJS from "exceljs";
import type { Cell, Workbook, Worksheet } from "exceljs";
import type { CompanyConfig, FormatAInput, FormatASection } from "./types";
import { groupLinesIntoSections, lineDescription } from "./types";

/**
 * Format A — Excel renderer (exceljs). Produces the workbook counterpart of the
 * PDF: an estimator can open it, tweak a quantity, and watch the subtotals and
 * grand total recompute — so **money is expressed as live formulas, not baked
 * numbers**. The engine's authoritative paise values are still carried through
 * as each formula's cached `result`, so a consumer that never recalculates
 * (e.g. a quick programmatic read) still sees the correct figure.
 *
 * Workbook layout (three sheets):
 *  1. **Summary** — client/project/estimate meta, then a Total SITC / GST /
 *     Grand Total breakout whose cells reference the BOQ sheet's grand-total
 *     cells (cross-sheet live formulas).
 *  2. **BOQ** — one sheet holding *all* PART sections as stacked blocks (merged
 *     PART title row → column header → item rows → SUM subtotal), then the
 *     Total SITC / GST / Grand Total rollup. A single sheet (rather than one per
 *     system) keeps a client's whole BOQ scrollable in one place and lets the
 *     Summary reference stable cells.
 *  3. **Terms** — the numbered Terms & Conditions.
 *
 * Currency cells use the Indian-grouped format `"₹"#,##,##0.00`.
 */

/** Indian rupee number format (2dp, lakh/crore grouping). */
const INR_FORMAT = '"₹"#,##,##0.00';
const ACCENT = "FF1F4E3D";
const ACCENT_SOFT = "FFEEF4F1";
const BAND = "FFF5F5F3";

/** BOQ column order (1-based Excel columns). */
const COL = {
  sl: 1, // A
  desc: 2, // B
  make: 3, // C
  unit: 4, // D
  qty: 5, // E
  rate: 6, // F  Unit Price (SITC)
  amount: 7, // G
  remarks: 8, // H
} as const;

const AMOUNT_COL_LETTER = "G";
const RATE_COL_LETTER = "F";
const QTY_COL_LETTER = "E";

/** Apply the ₹ number format to a cell and right-align it. */
function money(cell: Cell): Cell {
  cell.numFmt = INR_FORMAT;
  cell.alignment = { horizontal: "right", vertical: "middle" };
  return cell;
}

/** Solid fill helper. */
function fill(cell: Cell, argb: string): void {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}

/** White bold text on the accent colour (header cells). */
function accentHeader(cell: Cell): void {
  fill(cell, ACCENT);
  cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
}

// ─── Summary sheet ──────────────────────────────────────────────────────────

function buildSummarySheet(
  sheet: Worksheet,
  input: FormatAInput,
  boqTotalsRows: { totalSitc: number; gst: number; grand: number },
): void {
  sheet.columns = [{ width: 22 }, { width: 48 }];
  const { estimate, project, company, totals } = input;

  // Title band.
  sheet.mergeCells("A1:B1");
  const title = sheet.getCell("A1");
  title.value = company.name;
  title.font = { bold: true, size: 16, color: { argb: ACCENT } };
  title.alignment = { horizontal: "center" };

  sheet.mergeCells("A2:B2");
  const subtitle = sheet.getCell("A2");
  subtitle.value = "Budgetary Estimate / Quotation — Summary";
  subtitle.font = { italic: true, color: { argb: "FF555555" } };
  subtitle.alignment = { horizontal: "center" };

  let r = 4;
  const meta: Array<[string, string]> = [
    ["Estimate No.", estimate.estimateId],
    ["Revision", estimate.revision],
    ["Date", estimate.dateISO],
    ["Validity", `${estimate.validityDays} days`],
    ["Client", project.clientName],
    ["Project", project.projectName],
  ];
  if (project.buildingType) meta.push(["Building Type", project.buildingType]);
  if (project.applicableStandard) meta.push(["Standard", project.applicableStandard]);
  if (project.clientEmail) meta.push(["Client Email", project.clientEmail]);
  if (project.clientPhone) meta.push(["Client Phone", project.clientPhone]);
  meta.push(["Company GSTIN", company.gstin]);
  if (input.blendedRatio != null)
    meta.push(["Blended SITC Ratio", input.blendedRatio.toFixed(3)]);
  if (input.sitcStatus) meta.push(["SITC Status", input.sitcStatus]);

  for (const [label, value] of meta) {
    const k = sheet.getCell(r, 1);
    k.value = label;
    k.font = { bold: true, color: { argb: "FF555555" } };
    sheet.getCell(r, 2).value = value;
    r += 1;
  }

  // Totals breakout — cross-sheet formulas referencing the BOQ rollup cells so
  // the Summary always mirrors the (recomputable) BOQ.
  r += 1;
  const totalsHeader = sheet.getCell(r, 1);
  sheet.mergeCells(r, 1, r, 2);
  totalsHeader.value = "Estimate Totals";
  accentHeader(totalsHeader);
  totalsHeader.alignment = { horizontal: "left" };
  r += 1;

  // NOTE: exceljs formula strings must NOT carry a leading "=".
  const totalsRows: Array<[string, string, number]> = [
    ["Total (SITC)", `'BOQ'!G${boqTotalsRows.totalSitc}`, paiseToRupees(totals.totalSitcPaise)],
    [`GST @ ${gstLabel()}`, `'BOQ'!G${boqTotalsRows.gst}`, paiseToRupees(totals.gstPaise)],
    ["Grand Total", `'BOQ'!G${boqTotalsRows.grand}`, paiseToRupees(totals.grandTotalPaise)],
  ];
  for (const [label, formula, result] of totalsRows) {
    const k = sheet.getCell(r, 1);
    k.value = label;
    k.font = { bold: label === "Grand Total" };
    const v = sheet.getCell(r, 2);
    v.value = { formula, result };
    money(v);
    if (label === "Grand Total") {
      accentHeader(k);
      accentHeader(v);
      money(v);
    }
    r += 1;
  }
}

// ─── BOQ sheet ──────────────────────────────────────────────────────────────

interface BoqBuildResult {
  totalSitcRow: number;
  gstRow: number;
  grandRow: number;
}

function buildBoqSheet(
  sheet: Worksheet,
  input: FormatAInput,
  sections: FormatASection[],
): BoqBuildResult {
  sheet.columns = [
    { width: 6 }, // Sl.No
    { width: 46 }, // Description
    { width: 20 }, // Make
    { width: 9 }, // Unit
    { width: 9 }, // Qty
    { width: 16 }, // Unit Price (SITC)
    { width: 18 }, // Amount
    { width: 24 }, // Remarks
  ];

  const lastCol = COL.remarks;
  const { estimate, project, company } = input;

  // Title band.
  sheet.mergeCells(1, 1, 1, lastCol);
  const t = sheet.getCell(1, 1);
  t.value = `${company.name} — Budgetary Estimate / Quotation`;
  t.font = { bold: true, size: 14, color: { argb: ACCENT } };
  t.alignment = { horizontal: "center" };

  sheet.mergeCells(2, 1, 2, lastCol);
  const meta = sheet.getCell(2, 1);
  meta.value = `Estimate No. ${estimate.estimateId}  (Rev ${estimate.revision})   |   Client: ${project.clientName}   |   Project: ${project.projectName}   |   Date: ${estimate.dateISO}`;
  meta.font = { size: 9, color: { argb: "FF555555" } };
  meta.alignment = { horizontal: "center" };

  let r = 4;
  const subtotalRows: number[] = [];

  for (const section of sections) {
    // PART title row (merged).
    sheet.mergeCells(r, 1, r, lastCol);
    const titleCell = sheet.getCell(r, 1);
    titleCell.value = section.title;
    fill(titleCell, ACCENT_SOFT);
    titleCell.font = { bold: true, color: { argb: ACCENT } };
    r += 1;

    // Column header row.
    const headers = [
      "Sl.No",
      "Description",
      "Make",
      "Unit",
      "Qty",
      "Unit Price (SITC)",
      "Amount",
      "Remarks",
    ];
    headers.forEach((h, i) => {
      const c = sheet.getCell(r, i + 1);
      c.value = h;
      accentHeader(c);
      c.alignment = { horizontal: "center", vertical: "middle" };
    });
    r += 1;

    const firstItemRow = r;
    section.lines.forEach((line, idx) => {
      sheet.getCell(r, COL.sl).value = idx + 1;
      sheet.getCell(r, COL.sl).alignment = { horizontal: "center" };
      sheet.getCell(r, COL.desc).value = lineDescription(line);
      sheet.getCell(r, COL.desc).alignment = { wrapText: true, vertical: "top" };
      sheet.getCell(r, COL.make).value = line.brandName ?? "—";
      sheet.getCell(r, COL.unit).value = line.unit;
      sheet.getCell(r, COL.unit).alignment = { horizontal: "center" };
      const qty = sheet.getCell(r, COL.qty);
      qty.value = line.qty;
      qty.alignment = { horizontal: "right" };
      money(sheet.getCell(r, COL.rate)).value = paiseToRupees(line.sitcRatePaise);
      // Amount = Qty × Unit Price — a live formula, with the engine's rounded
      // paise value carried as the cached result.
      const amt = money(sheet.getCell(r, COL.amount));
      amt.value = {
        formula: `${QTY_COL_LETTER}${r}*${RATE_COL_LETTER}${r}`,
        result: paiseToRupees(line.lineAmountPaise),
      };
      sheet.getCell(r, COL.remarks).value =
        line.note && line.note.trim().length > 0 ? line.note : "—";
      sheet.getCell(r, COL.remarks).alignment = { wrapText: true, vertical: "top" };
      r += 1;
    });
    const lastItemRow = r - 1;

    // Section subtotal (SUM formula over the section's amount cells).
    sheet.mergeCells(r, 1, r, COL.rate);
    const subLabel = sheet.getCell(r, 1);
    subLabel.value = `Sub-total — ${section.systemLabel}`;
    subLabel.font = { bold: true };
    subLabel.alignment = { horizontal: "right" };
    fill(subLabel, BAND);
    const subCell = money(sheet.getCell(r, COL.amount));
    subCell.font = { bold: true };
    fill(subCell, BAND);
    const sumFormula =
      section.lines.length > 0
        ? `SUM(${AMOUNT_COL_LETTER}${firstItemRow}:${AMOUNT_COL_LETTER}${lastItemRow})`
        : "0";
    subCell.value = { formula: sumFormula, result: paiseToRupees(section.subtotalPaise) };
    fill(sheet.getCell(r, COL.remarks), BAND);
    subtotalRows.push(r);
    r += 1;
  }

  // ── Rollup: Total SITC (sum of subtotals) → GST → Grand Total ──
  r += 1;
  const { totals } = input;

  const totalSitcRow = r;
  writeRollupRow(
    sheet,
    r,
    "Total (SITC)",
    subtotalRows.length > 0
      ? `${subtotalRows.map((sr) => `${AMOUNT_COL_LETTER}${sr}`).join("+")}`
      : "0",
    paiseToRupees(totals.totalSitcPaise),
    false,
  );
  r += 1;

  const gstRow = r;
  writeRollupRow(
    sheet,
    r,
    `GST @ ${gstLabel()}`,
    `${AMOUNT_COL_LETTER}${totalSitcRow}*${GST_RATE}`,
    paiseToRupees(totals.gstPaise),
    false,
  );
  r += 1;

  const grandRow = r;
  writeRollupRow(
    sheet,
    r,
    "Grand Total",
    `${AMOUNT_COL_LETTER}${totalSitcRow}+${AMOUNT_COL_LETTER}${gstRow}`,
    paiseToRupees(totals.grandTotalPaise),
    true,
  );

  return { totalSitcRow, gstRow, grandRow };
}

/** Write one rollup row: a merged right-aligned label + a formula amount cell. */
function writeRollupRow(
  sheet: Worksheet,
  row: number,
  label: string,
  formula: string,
  result: number,
  grand: boolean,
): void {
  sheet.mergeCells(row, 1, row, COL.rate);
  const labelCell = sheet.getCell(row, 1);
  labelCell.value = label;
  labelCell.alignment = { horizontal: "right" };
  labelCell.font = { bold: true };
  const amt = money(sheet.getCell(row, COL.amount));
  amt.value = { formula, result };
  amt.font = { bold: true };
  if (grand) {
    accentHeader(labelCell);
    labelCell.alignment = { horizontal: "right" };
    accentHeader(amt);
    money(amt);
    amt.font = { bold: true, color: { argb: "FFFFFFFF" } };
  } else {
    fill(labelCell, BAND);
    fill(sheet.getCell(row, COL.amount), BAND);
  }
}

// ─── Terms sheet ────────────────────────────────────────────────────────────

function buildTermsSheet(sheet: Worksheet, company: CompanyConfig): void {
  sheet.columns = [{ width: 6 }, { width: 110 }];
  sheet.mergeCells("A1:B1");
  const title = sheet.getCell("A1");
  title.value = "Terms & Conditions";
  title.font = { bold: true, size: 14, color: { argb: ACCENT } };

  let r = 3;
  company.termsAndConditions.forEach((term, idx) => {
    const num = sheet.getCell(r, 1);
    num.value = idx + 1;
    num.alignment = { horizontal: "center", vertical: "top" };
    num.font = { bold: true };
    const text = sheet.getCell(r, 2);
    text.value = term;
    text.alignment = { wrapText: true, vertical: "top" };
    r += 1;
  });

  // Signatory block.
  r += 1;
  sheet.getCell(r, 2).value = company.signatoryName;
  sheet.getCell(r, 2).font = { bold: true };
  r += 1;
  sheet.getCell(r, 2).value = company.signatoryCredentials;
  sheet.getCell(r, 2).font = { italic: true, color: { argb: "FF555555" } };
}

/** GST percentage label from the shared rate (0.18 → "18%"). */
function gstLabel(): string {
  return `${Number((GST_RATE * 100).toFixed(2))}%`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the Format A workbook (Summary + BOQ + Terms) with live money formulas.
 * The BOQ is built first so the Summary can reference its rollup cells.
 */
export async function buildFormatAWorkbook(input: FormatAInput): Promise<Workbook> {
  const sections = groupLinesIntoSections(input.lines);
  const wb = new ExcelJS.Workbook();
  wb.creator = input.company.name;
  wb.created = new Date(input.estimate.dateISO);

  const summary = wb.addWorksheet("Summary");
  const boq = wb.addWorksheet("BOQ");
  const terms = wb.addWorksheet("Terms");

  const rollup = buildBoqSheet(boq, input, sections);
  buildSummarySheet(summary, input, {
    totalSitc: rollup.totalSitcRow,
    gst: rollup.gstRow,
    grand: rollup.grandRow,
  });
  buildTermsSheet(terms, input.company);

  return wb;
}

/** Convenience: build the workbook and return its `.xlsx` bytes as a Buffer. */
export async function formatAWorkbookBuffer(input: FormatAInput): Promise<Buffer> {
  const wb = await buildFormatAWorkbook(input);
  const data = await wb.xlsx.writeBuffer();
  return Buffer.from(data as ArrayBuffer);
}
