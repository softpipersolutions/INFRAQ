import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { pdfPageCount, splitPdfWindows } from "../src/ingest/pdf-window";

/** Build an in-memory PDF with `n` blank pages, for windowing tests. */
async function buildPdf(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([200, 200]);
  return doc.save();
}

describe("pdfPageCount", () => {
  it("reports the exact page count", async () => {
    expect(await pdfPageCount(await buildPdf(1))).toBe(1);
    expect(await pdfPageCount(await buildPdf(14))).toBe(14);
    expect(await pdfPageCount(await buildPdf(37))).toBe(37);
  });
});

describe("splitPdfWindows", () => {
  it("14 pages, default window 6 / overlap 1 -> [1-6][6-11][11-14]", async () => {
    const bytes = await buildPdf(14);
    const windows = await splitPdfWindows(bytes);
    expect(windows.map((w) => [w.pageStart, w.pageEnd])).toEqual([
      [1, 6],
      [6, 11],
      [11, 14],
    ]);
    // Each window is itself a standalone, valid PDF with the expected page count.
    for (const w of windows) {
      const doc = await PDFDocument.load(w.bytes);
      expect(doc.getPageCount()).toBe(w.pageEnd - w.pageStart + 1);
    }
  });

  it("8 pages -> a single whole-document window starting at page 1", async () => {
    const bytes = await buildPdf(8);
    const windows = await splitPdfWindows(bytes);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ pageStart: 1, pageEnd: 8 });
    const doc = await PDFDocument.load(windows[0]!.bytes);
    expect(doc.getPageCount()).toBe(8);
  });

  it("1 page -> a single whole-document window", async () => {
    const windows = await splitPdfWindows(await buildPdf(1));
    expect(windows).toEqual([{ pageStart: 1, pageEnd: 1, bytes: expect.any(Uint8Array) }]);
  });

  it("exactly 9 pages (just over the ≤8 short-circuit) windows normally", async () => {
    const windows = await splitPdfWindows(await buildPdf(9));
    expect(windows.map((w) => [w.pageStart, w.pageEnd])).toEqual([
      [1, 6],
      [6, 9],
    ]);
  });

  it("respects custom windowSize/overlap", async () => {
    const windows = await splitPdfWindows(await buildPdf(20), { windowSize: 5, overlap: 2 });
    expect(windows.map((w) => [w.pageStart, w.pageEnd])).toEqual([
      [1, 5],
      [4, 8],
      [7, 11],
      [10, 14],
      [13, 17],
      [16, 20],
    ]);
  });

  it("rejects an overlap >= windowSize", async () => {
    await expect(splitPdfWindows(await buildPdf(20), { windowSize: 4, overlap: 4 })).rejects.toThrow();
  });
});
