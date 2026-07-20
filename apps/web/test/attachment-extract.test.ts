import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  capText,
  extractAttachmentText,
  extractXlsx,
  READ_TEXT_CAP,
} from "../src/server/attachment-extract";

/**
 * Text-extraction for the `read_attachment` tool (WP8) with REAL bytes: plain
 * text/csv/md verbatim, an xlsx built by exceljs rendered as sheet-by-sheet CSV,
 * the truncation cap, a scanned (text-less) PDF's advisory note, and docx/other
 * notes. No DB/storage — pure byte-in, text-out.
 */

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function buildXlsx(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Rates");
  ws.addRow(["Material", "Rate"]);
  ws.addRow(["FAS-SMK-001", 1250]);
  ws.addRow(["Hydrant, with comma", 9999]);
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

describe("extractAttachmentText — text formats", () => {
  it("returns text/plain verbatim", async () => {
    const r = await extractAttachmentText({ mediaType: "text/plain", filename: "n.txt", bytes: utf8("hello world") });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("hello world");
    expect(r.truncated).toBe(false);
  });

  it("returns markdown and csv verbatim", async () => {
    const md = await extractAttachmentText({ mediaType: "text/markdown", filename: "n.md", bytes: utf8("# Title") });
    expect(md.text).toBe("# Title");
    const csv = await extractAttachmentText({ mediaType: "text/csv", filename: "n.csv", bytes: utf8("a,b\n1,2") });
    expect(csv.text).toBe("a,b\n1,2");
  });
});

describe("extractAttachmentText — xlsx → CSV", () => {
  it("renders each sheet as CSV with a header, quoting cells with commas", async () => {
    const r = await extractXlsx(await buildXlsx());
    expect(r.ok).toBe(true);
    expect(r.text).toContain("## Rates");
    expect(r.text).toContain("Material,Rate");
    expect(r.text).toContain("FAS-SMK-001,1250");
    // A cell containing a comma is quoted.
    expect(r.text).toContain('"Hydrant, with comma",9999');
  });

  it("routes xlsx media type through the top-level extractor", async () => {
    const r = await extractAttachmentText({
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "rates.xlsx",
      bytes: await buildXlsx(),
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Material,Rate");
  });

  it("returns a note for corrupted xlsx bytes rather than throwing", async () => {
    const r = await extractXlsx(utf8("not a spreadsheet"));
    expect(r.ok).toBe(false);
    expect(r.note).toBeTruthy();
  });
});

describe("extractAttachmentText — pdf", () => {
  it("treats a text-less (scanned) PDF as scanned with an advisory note", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const bytes = await doc.save();
    const r = await extractAttachmentText({ mediaType: "application/pdf", filename: "scan.pdf", bytes });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/scanned/i);
  });
});

describe("extractAttachmentText — office/other notes", () => {
  it("docx returns a note directing to the Office lane", async () => {
    const r = await extractAttachmentText({
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "d.docx",
      bytes: utf8("x"),
    });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/Word|Office/i);
  });

  it("an unknown type returns a note", async () => {
    const r = await extractAttachmentText({ mediaType: "application/zip", filename: "a.zip", bytes: utf8("PK") });
    expect(r.ok).toBe(false);
    expect(r.note).toBeTruthy();
  });
});

describe("capText", () => {
  it("passes short text through untruncated", () => {
    expect(capText("short")).toEqual({ text: "short", truncated: false });
  });

  it("truncates and appends a note past the cap", () => {
    const long = "x".repeat(READ_TEXT_CAP + 100);
    const { text, truncated } = capText(long);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(long.length);
    expect(text).toMatch(/truncated/i);
  });
});
