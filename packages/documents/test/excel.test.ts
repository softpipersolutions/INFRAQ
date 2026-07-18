import { paiseToRupees } from "@pebble/shared";
import ExcelJS from "exceljs";
import type { Cell, Worksheet } from "exceljs";
import { describe, expect, it } from "vitest";
import { formatAWorkbookBuffer } from "../src/index";
import { fixtureInput, fixtureTotals } from "./fixture";

const INR_FORMAT = '"₹"#,##,##0.00';

/**
 * Re-parse produced bytes with a fresh workbook. The cast bridges the Node
 * `Buffer` we return from the public API to exceljs's own `Buffer` type
 * (structurally `ArrayBuffer`); at runtime exceljs accepts the Node Buffer.
 */
async function reload(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

/** Find the first row whose column-A value equals `label`; return its cells. */
function findRowByLabel(sheet: Worksheet, label: string): Cell[] | null {
  let found: Cell[] | null = null;
  sheet.eachRow((row) => {
    if (found) return;
    const a = row.getCell(1).value;
    if (typeof a === "string" && a === label) {
      const cells: Cell[] = [];
      row.eachCell({ includeEmpty: true }, (c) => cells.push(c));
      found = cells;
    }
  });
  return found;
}

/** True when a cell value is an exceljs formula object. */
function isFormula(value: unknown): value is { formula: string; result?: unknown } {
  return typeof value === "object" && value !== null && "formula" in value;
}

/**
 * Excel: generate the workbook → re-parse the produced buffer with a *fresh*
 * `ExcelJS.Workbook` → assert structure, formulas, cached values, and the ₹
 * number formats survived the round-trip.
 */
describe("buildFormatAWorkbook / formatAWorkbookBuffer", () => {
  const input = fixtureInput();
  const totals = fixtureTotals();

  it("produces a workbook that re-parses with the expected sheets", async () => {
    const buffer = await formatAWorkbookBuffer(input);
    expect(buffer.byteLength).toBeGreaterThan(0);

    const wb = await reload(buffer);

    expect(wb.getWorksheet("Summary")).toBeTruthy();
    expect(wb.getWorksheet("BOQ")).toBeTruthy();
    expect(wb.getWorksheet("Terms")).toBeTruthy();
  });

  it("holds the grand total as a formula with the ₹ number format (Summary)", async () => {
    const wb = await reload(await formatAWorkbookBuffer(input));
    const summary = wb.getWorksheet("Summary");
    expect(summary).toBeTruthy();

    const grandRow = findRowByLabel(summary as Worksheet, "Grand Total");
    expect(grandRow).toBeTruthy();
    const valueCell = grandRow![1]!; // column B
    expect(valueCell.numFmt).toBe(INR_FORMAT);
    // It is a live (cross-sheet) formula, and carries the engine's value cached.
    expect(isFormula(valueCell.value)).toBe(true);
    if (isFormula(valueCell.value)) {
      expect(valueCell.value.formula).toContain("BOQ");
      expect(valueCell.value.result).toBeCloseTo(
        paiseToRupees(totals.grandTotalPaise),
        2,
      );
    }
  });

  it("computes BOQ subtotals and grand total with live formulas", async () => {
    const wb = await reload(await formatAWorkbookBuffer(input));
    const boq = wb.getWorksheet("BOQ") as Worksheet;

    // At least one section subtotal is a SUM(...) formula.
    let sawSum = false;
    let sawAmountFormula = false;
    boq.eachRow((row) => {
      row.eachCell((cell) => {
        if (isFormula(cell.value)) {
          if (cell.value.formula.startsWith("SUM(")) sawSum = true;
          // Item Amount = Qty × Unit Price (e.g. "E5*F5").
          if (/^E\d+\*F\d+$/.test(cell.value.formula)) sawAmountFormula = true;
        }
      });
    });
    expect(sawSum).toBe(true);
    expect(sawAmountFormula).toBe(true);

    // The BOQ grand total's cached result matches the engine total exactly.
    const grandRow = findRowByLabel(boq, "Grand Total");
    expect(grandRow).toBeTruthy();
    const amountCell = grandRow![6]!; // column G
    expect(amountCell.numFmt).toBe(INR_FORMAT);
    expect(isFormula(amountCell.value)).toBe(true);
    if (isFormula(amountCell.value)) {
      expect(amountCell.value.result).toBeCloseTo(
        paiseToRupees(totals.grandTotalPaise),
        2,
      );
    }
  });

  it("carries the terms and a currency-formatted unit price", async () => {
    const wb = await reload(await formatAWorkbookBuffer(input));
    const terms = wb.getWorksheet("Terms") as Worksheet;
    let sawTerm = false;
    terms.eachRow((row) => {
      row.eachCell((cell) => {
        if (
          typeof cell.value === "string" &&
          cell.value.includes("valid for 7 days")
        ) {
          sawTerm = true;
        }
      });
    });
    expect(sawTerm).toBe(true);

    // A unit-price cell on the BOQ uses the ₹ format.
    const boq = wb.getWorksheet("BOQ") as Worksheet;
    let sawInrFormatted = false;
    boq.eachRow((row) => {
      const rate = row.getCell(6); // column F — Unit Price (SITC)
      if (rate.numFmt === INR_FORMAT && typeof rate.value === "number") {
        sawInrFormatted = true;
      }
    });
    expect(sawInrFormatted).toBe(true);
  });
});
