import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseXlsxWorkbook } from "../src/ingest/xlsx";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "../../../proposal-corpus");

/**
 * These 3 workbooks were opened cell-by-cell during development (see the WP2
 * report) to pick stable expected values — this test asserts against real,
 * observed sheet layouts, not a guessed shape.
 *
 *  - "FF-103 V Proseware Hotel (09112024 R0).xlsx", sheet "BOM": a
 *    commercial-BOM layout (Sl.No/Description/Unit/Quantity/"Unit Price
 *    (SITC)"/Amount/Remarks), make embedded in the description as
 *    "Make - X" (sometimes doubled "Make - Make - X").
 *  - "EXTERNAL FIRE FIGHTING - Proposal by Greenberg Enterprises
 *    (26022025).xlsx" and "SPRINKLER BUILDING - Proposal by Greenberg
 *    Enterprises (26022025).xlsx", sheet "FIRE FIGHTING ESTIMATE": a
 *    DSR-style estimate with three parallel amount columns (S.O.R/D.S.R/
 *    M.R.) at different column indices between the two files, plus an
 *    internal "F.F. RATE ANALYSIS" cost-buildup sheet that is deliberately
 *    NOT parsed (see xlsx.ts's SKIP_SHEET_NAME_RE).
 */

describe("parseXlsxWorkbook — FF-103 V Proseware Hotel (commercial_bom)", () => {
  it("parses the BOM sheet with the expected layout and totals", async () => {
    const bytes = await readFile(join(CORPUS_DIR, "FF-103 V Proseware Hotel (09112024 R0).xlsx"));
    const result = await parseXlsxWorkbook(bytes);

    expect(result.schemaKind).toBe("commercial_bom");
    expect(result.lines.length).toBe(74);
    for (const line of result.lines) {
      expect(line.locator.sheet).toBe("BOM");
      expect(line.locator.row).toBeGreaterThan(0);
      expect(line.page).toBe(0);
    }

    // Spot check #1 — first real item row (A1: ring-line MS pipe).
    const first = result.lines[0]!;
    expect(first.slNo).toBe("A1");
    expect(first.description).toContain("SITC M.S. Pipe Class 'C' 150 mm");
    expect(first.makeRaw).toBe("Jindal (ISI)");
    expect(first.qty).toBe(138);
    expect(first.unitRaw).toBe("mtr");
    expect(first.unitRateRupees).toBe(2280);
    expect(first.amountRupees).toBe(314640);
    expect(first.section).toBe("A. RING LINE & EXTERNAL YARD HYDRANTS");
    expect(first.rateKind).toBe("SITC");
    expect(first.locator).toEqual({ sheet: "BOM", row: 8 });

    // Spot check #2 — a row whose Make label appears doubled in the source
    // ("Make - Make - Kartar (ISI)"); extraction takes the LAST occurrence.
    const butterflyValve = result.lines.find((l) => l.slNo === "A5");
    expect(butterflyValve?.makeRaw).toBe("Swastik Technocat OR Kartar OR Zoloto (ISI)");

    // Spot check #3 — a "PART II (WIP)" placeholder line (qty/rate both 0,
    // make is a TBC placeholder) still parses as a real, zero-value line.
    const wipLine = result.lines.find((l) => l.locator.row === 103);
    expect(wipLine).toMatchObject({
      slNo: "5",
      makeRaw: "ISI Brand",
      qty: 0,
      unitRaw: "mtr",
      amountRupees: 0,
      section: "PART II. ALARMS & ASSITANCE: (WIP)",
    });
  });
});

describe("parseXlsxWorkbook — EXTERNAL FIRE FIGHTING (dsr_estimate)", () => {
  it("parses the FIRE FIGHTING ESTIMATE sheet, skips the RATE ANALYSIS sheet", async () => {
    const bytes = await readFile(
      join(CORPUS_DIR, "EXTERNAL FIRE FIGHTING - Proposal by Greenberg Enterprises (26022025).xlsx"),
    );
    const result = await parseXlsxWorkbook(bytes);

    expect(result.schemaKind).toBe("dsr_estimate");
    expect(result.lines.length).toBe(44);
    expect(result.warnings.some((w) => /rate.analysis/i.test(w))).toBe(true);
    for (const line of result.lines) {
      expect(line.locator.sheet).toBe("FIRE FIGHTING ESTIMATE");
      expect(line.page).toBe(0);
    }

    // The sum of the extracted per-line amounts reconciles exactly with the
    // workbook's own SUMMARY!C10 "SUB TOTAL" cell (2,765,490) — a strong
    // cross-check that the DSR/SOR/MR amount-column fallback picks the right
    // value on every row.
    const total = result.lines.reduce((s, l) => s + (l.amountRupees ?? 0), 0);
    expect(total).toBe(2765490);

    const first = result.lines[0]!;
    expect(first).toMatchObject({
      slNo: "18.1.4",
      description: "2280 lpm at 88 m Head",
      qty: 2,
      unitRaw: "Set",
      unitRateRupees: 590000,
      amountRupees: 1180000,
      section: "EXTERNAL FIRE HYDRANT & FIRE PUMPS",
    });

    // A row whose amount is only populated in the M.R. (market rate) column,
    // not D.S.R. — the fallback must still pick it up.
    const mrRow = result.lines.find((l) => l.description.includes("FRP Hose Box"));
    expect(mrRow?.amountRupees).toBe(11200);
  });
});

describe("parseXlsxWorkbook — SPRINKLER BUILDING (dsr_estimate)", () => {
  it("parses with a differently-positioned column layout than the other DSR file", async () => {
    const bytes = await readFile(
      join(CORPUS_DIR, "SPRINKLER BUILDING - Proposal by Greenberg Enterprises (26022025).xlsx"),
    );
    const result = await parseXlsxWorkbook(bytes);

    expect(result.schemaKind).toBe("dsr_estimate");
    expect(result.lines.length).toBe(37);
    for (const line of result.lines) {
      expect(line.locator.sheet).toBe("FIRE FIGHTING ESTIMATE");
    }

    // Reconciles with SUMMARY!C10 "SUB TOTAL" (1,178,530).
    const total = result.lines.reduce((s, l) => s + (l.amountRupees ?? 0), 0);
    expect(total).toBe(1178530);

    const first = result.lines[0]!;
    expect(first).toMatchObject({
      slNo: "16.8",
      qty: 10,
      unitRaw: "Each",
      unitRateRupees: 1450,
      amountRupees: 14500,
      section: "INTERNAL FIRE HYDRANT & SPRINKLER SYSTEM",
    });

    const sections = new Set(result.lines.map((l) => l.section));
    expect(sections).toEqual(new Set(["INTERNAL FIRE HYDRANT & SPRINKLER SYSTEM", "FIRE EXTINGUSHER"]));
  });
});

describe("parseXlsxWorkbook — unrecognized layout", () => {
  it("never throws; reports schemaKind unknown with no lines", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Random");
    sheet.addRow(["Not", "A", "BOQ", "Header"]);
    sheet.addRow(["foo", "bar", "baz", "qux"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const result = await parseXlsxWorkbook(buf);
    expect(result.schemaKind).toBe("unknown");
    expect(result.lines).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
