import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCorpusFilename, sourceEntityForDate } from "../src/ingest/filename";
import corpusFilenamesSnapshot from "./fixtures/corpus-filenames.json";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/worker/test -> apps/worker -> apps -> repo root, where the historical
// corpus lives (see WP2 task spec: "Amitabh Fire Safety BOQ Data/").
const CORPUS_DIR = join(__dirname, "../../../Amitabh Fire Safety BOQ Data");

function corpusFiles(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((f) => !f.startsWith("."))
    .sort();
}

function utcYmd(d: Date): [number, number, number] {
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

describe("parseCorpusFilename — live corpus", () => {
  it("dir contents match the committed snapshot (drift guard)", () => {
    expect(corpusFiles()).toEqual(corpusFilenamesSnapshot);
  });

  it("never throws and always assigns a correct docType, for every real corpus file", () => {
    for (const filename of corpusFiles()) {
      const parsed = expect(() => parseCorpusFilename(filename)).not.toThrow();
      const result = parseCorpusFilename(filename);
      const expectedDocType = filename.toLowerCase().endsWith(".xlsx")
        ? "xlsx"
        : filename.toLowerCase().endsWith(".pdf")
          ? "pdf"
          : "other";
      expect(result.docType, filename).toBe(expectedDocType);
      expect(Array.isArray(result.warnings), filename).toBe(true);
      void parsed;
    }
  });

  it("aggregate: at least 130 of 145 files resolve a non-null fileRef", () => {
    const files = corpusFiles();
    const withRef = files.filter((f) => parseCorpusFilename(f).fileRef !== null);
    expect(files.length).toBe(145);
    expect(withRef.length).toBeGreaterThanOrEqual(130);
  });

  it("all 3 xlsx files are recognized as docType xlsx", () => {
    const xlsxFiles = corpusFiles().filter((f) => f.toLowerCase().endsWith(".xlsx"));
    expect(xlsxFiles.length).toBe(3);
    for (const f of xlsxFiles) {
      expect(parseCorpusFilename(f).docType).toBe("xlsx");
    }
  });
});

describe("parseCorpusFilename — variance cases", () => {
  it("1. canonical: fileRef + date + revision", () => {
    const r = parseCorpusFilename("FF-01 Shri Narayan Plaza - SITC Active Fire Fighting (21092022 R0).pdf");
    expect(r.fileRef).toBe("FF-01");
    expect(r.revision).toBe("R0");
    expect(r.docDate).not.toBeNull();
    expect(utcYmd(r.docDate as Date)).toEqual([2022, 9, 21]);
    expect(r.docType).toBe("pdf");
    expect(r.title).toContain("Shri Narayan Plaza");
  });

  it("2. sub-numbers: FF-05-1 -> fileRef FF-05, subRef 1", () => {
    const r = parseCorpusFilename(
      "FF-05-1 PSPL Lucknow Distilled Water Plant - SITC Compressed Air MS Pipework (10042023 R0).pdf",
    );
    expect(r.fileRef).toBe("FF-05");
    expect(r.subRef).toBe("1");
    expect(r.suffix).toBeNull();
  });

  it("3. letter suffix via hyphen, date/rev OUTSIDE parens: FF-126-B", () => {
    const r = parseCorpusFilename(
      "FF-126-B Fire Alarm System Cost Proposal by Greenberg (for Warehouse by AMT AVENTURES) 28042025 R1.pdf",
    );
    expect(r.fileRef).toBe("FF-126");
    expect(r.suffix).toBe("B");
    expect(r.subRef).toBeNull();
    expect(r.revision).toBe("R1");
    expect(r.docDate).not.toBeNull();
    expect(utcYmd(r.docDate as Date)).toEqual([2025, 4, 28]);
  });

  it("4. no hyphen: FF01 / FF57 normalize to FF-01 / FF-57 with a warning", () => {
    const a = parseCorpusFilename(
      "FF01 Charan Residence - Supply & Installation Fire Fighting Equipment (19092022 R0).pdf",
    );
    expect(a.fileRef).toBe("FF-01");
    expect(a.warnings.some((w) => /normalized/i.test(w))).toBe(true);

    const b = parseCorpusFilename("FF57 Ashish Kanwar - FE Supply (13112023 R0).pdf");
    expect(b.fileRef).toBe("FF-57");
    expect(b.warnings.some((w) => /normalized/i.test(w))).toBe(true);
  });

  it("5. GBE prefix supply/labour split pair", () => {
    const supply = parseCorpusFilename(
      "GBE-71 POCT C7 Fire Protection Systems (25052024 R5) - Supply Only.pdf",
    );
    expect(supply.fileRef).toBe("GBE-71");
    expect(supply.splitKind).toBe("supply_only");

    const labour = parseCorpusFilename(
      "GBE-71 POCT C7 Fire Protection Systems (25052024 R5) - Labour Charges.pdf",
    );
    expect(labour.fileRef).toBe("GBE-71");
    expect(labour.splitKind).toBe("labour_charges");
  });

  it("6. non-numeric reference: GBE-Shivanan-BOQ", () => {
    const r = parseCorpusFilename("GBE-Shivanan-BOQ (22072025 R2).pdf");
    expect(r.fileRef).toBe("GBE-Shivanan");
    expect(r.revision).toBe("R2");
  });

  it("7. no id/date/rev at all: title carries the name, warning raised", () => {
    const r = parseCorpusFilename("FFS for A3 plot (Hawkins) - Estimate by Greenberg Enterprises.pdf");
    expect(r.fileRef).toBeNull();
    expect(r.docDate).toBeNull();
    expect(r.revision).toBeNull();
    expect(r.title).toContain("A3 plot");
    expect(r.warnings.some((w) => /no file reference/i.test(w))).toBe(true);
  });

  it("8. malformed 7-digit date -> docDate null + warning", () => {
    const r = parseCorpusFilename("FF-119 POCT Electrical Panel Fire Safety (1702025 R0).pdf");
    expect(r.fileRef).toBe("FF-119");
    expect(r.docDate).toBeNull();
    expect(r.revision).toBe("R0");
    expect(r.warnings.some((w) => /malformed date/i.test(w))).toBe(true);
  });

  it("9. paren letter suffix + split kind: FF-30(L) / FF-30(S)", () => {
    const labour = parseCorpusFilename(
      "FF-30(L) POCT C42 Fire Protection Systems (13032024 R5) - Labour Charges.pdf",
    );
    expect(labour.fileRef).toBe("FF-30");
    expect(labour.suffix).toBe("L");
    expect(labour.splitKind).toBe("labour_charges");

    const supply = parseCorpusFilename(
      "FF-30(S) POCT C42 Fire Protection Systems (13032024 R5) - Supply Only.pdf",
    );
    expect(supply.fileRef).toBe("FF-30");
    expect(supply.suffix).toBe("S");
    expect(supply.splitKind).toBe("supply_only");
  });

  it("10. two-digit sub-reference: FF-33-05", () => {
    const r = parseCorpusFilename(
      "FF-33-05 Wadhwa Site Q-Lien Biotech Pvt Ltd - SITC Piezometer & Flow Meter (28082024 R0).pdf",
    );
    expect(r.fileRef).toBe("FF-33");
    expect(r.subRef).toBe("05");
  });

  it("11. invalid calendar date (Feb 31) -> docDate null + warning", () => {
    const r = parseCorpusFilename("FF-163 Fashion City (31022026 R0).pdf");
    expect(r.fileRef).toBe("FF-163");
    expect(r.docDate).toBeNull();
    expect(r.warnings.some((w) => /invalid date/i.test(w))).toBe(true);
  });

  it("12. fileRef with no date/rev/parens at all", () => {
    const r = parseCorpusFilename("FF-66 Commercial Gomti Nagar.pdf");
    expect(r.fileRef).toBe("FF-66");
    expect(r.docDate).toBeNull();
    expect(r.revision).toBeNull();
    expect(r.title).toBe("Commercial Gomti Nagar");
  });
});

describe("sourceEntityForDate", () => {
  it("attributes 2023 dates to Padmawati Enterprises", () => {
    expect(sourceEntityForDate(new Date(Date.UTC(2023, 5, 15)))).toBe("Padmawati Enterprises");
  });

  it("attributes non-2023 dates to Greenberg Enterprises", () => {
    expect(sourceEntityForDate(new Date(Date.UTC(2022, 8, 21)))).toBe("Greenberg Enterprises");
    expect(sourceEntityForDate(new Date(Date.UTC(2025, 3, 28)))).toBe("Greenberg Enterprises");
  });

  it("returns null for a null date", () => {
    expect(sourceEntityForDate(null)).toBeNull();
  });
});
