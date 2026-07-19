import { PDFDocument } from "pdf-lib";

/**
 * PDF page-windowing for the Phase B line-extraction pass (PLAN §4.5 step 3):
 * Gemini's multimodal extraction runs per-page-window rather than over a
 * whole (sometimes 30+ page) proposal, both to stay inside model context/
 * output limits and so a single bad window can be retried in isolation. Every
 * page number this module reports is **absolute and 1-based** against the
 * original document — `pageStart`/`pageEnd` on a window, and later the
 * `page` field on an extracted line, always mean "page N of the source PDF",
 * never an index into the window's own (re-numbered) byte stream.
 *
 * Windows are built by copying pages into fresh, independent `PDFDocument`s
 * (via `copyPages`) rather than slicing bytes, so each window is itself a
 * valid, self-contained PDF the extraction lane can hand straight to the
 * model.
 */

/** Total page count of a PDF, without materializing any window. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

export interface PdfWindow {
  /** 1-based, inclusive, absolute page number this window starts at. */
  pageStart: number;
  /** 1-based, inclusive, absolute page number this window ends at. */
  pageEnd: number;
  /** Bytes of a standalone PDF containing exactly pages [pageStart, pageEnd]. */
  bytes: Uint8Array;
}

export interface SplitPdfWindowsOptions {
  /** Pages per window. Default 6. */
  windowSize?: number;
  /** Pages shared between consecutive windows, so a BOQ row split across a
   *  window boundary still appears whole in at least one window. Default 1. */
  overlap?: number;
}

/** Build a standalone single-window PDF containing the given page range. */
async function buildWindow(
  src: PDFDocument,
  pageStart: number,
  pageEnd: number,
): Promise<PdfWindow> {
  const indices: number[] = [];
  for (let p = pageStart; p <= pageEnd; p++) indices.push(p - 1);
  const doc = await PDFDocument.create();
  const pages = await doc.copyPages(src, indices);
  for (const page of pages) doc.addPage(page);
  const bytes = await doc.save();
  return { pageStart, pageEnd, bytes };
}

/**
 * Split a PDF into overlapping page windows for the extraction lane.
 *
 * Short documents (≤8 pages) are returned as a single whole-document window
 * (`pageStart: 1`) — windowing exists to keep a single model call within
 * limits, which is moot for anything that already fits comfortably, and
 * skipping it avoids a spurious extra call for the ~half the corpus that is
 * short proposals.
 */
export async function splitPdfWindows(
  bytes: Uint8Array,
  opts: SplitPdfWindowsOptions = {},
): Promise<PdfWindow[]> {
  const windowSize = opts.windowSize ?? 6;
  const overlap = opts.overlap ?? 1;
  if (windowSize <= 0) throw new Error(`windowSize must be positive, got ${windowSize}`);
  if (overlap < 0) throw new Error(`overlap must be non-negative, got ${overlap}`);
  if (overlap >= windowSize) {
    throw new Error(`overlap (${overlap}) must be smaller than windowSize (${windowSize})`);
  }

  const src = await PDFDocument.load(bytes);
  const pageCount = src.getPageCount();

  if (pageCount <= 8) {
    return [await buildWindow(src, 1, pageCount)];
  }

  const windows: PdfWindow[] = [];
  const step = windowSize - overlap;
  let start = 1;
  while (start <= pageCount) {
    const end = Math.min(start + windowSize - 1, pageCount);
    windows.push(await buildWindow(src, start, end));
    if (end >= pageCount) break;
    start += step;
  }
  return windows;
}
