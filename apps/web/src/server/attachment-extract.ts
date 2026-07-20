import "server-only";

/**
 * Pure text-extraction for the chat `read_attachment` tool (Chat overhaul WP8).
 *
 * Given an attachment's bytes + media type, produce the TEXT the agent should
 * read back:
 *   - text/plain, text/markdown, text/csv → decoded verbatim (UTF-8), capped;
 *   - xlsx → sheet-by-sheet CSV via exceljs;
 *   - pdf → embedded text via `unpdf` (a pure-JS pdf.js build). A PDF that
 *     yields (almost) no text is treated as scanned → a note telling the user
 *     to attach it to a message so vision can read it;
 *   - docx/pptx → a note directing the user to the Office (skills) lane.
 *
 * Extraction is deliberately factored out of the service so it is unit-testable
 * with real bytes and NO database/storage — see attachment-extract.test.ts.
 * Every path is defensive: a malformed file returns a note, never throws.
 */

/** Cap on returned text (chars). A larger file is truncated with a note. */
export const READ_TEXT_CAP = 50_000;

const MEDIA = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export interface ExtractResult {
  ok: boolean;
  /** Extracted text (present when the file yielded readable text). */
  text?: string;
  /** True when `text` was capped at READ_TEXT_CAP (a note is appended to `text`). */
  truncated?: boolean;
  /** A human note when there is no directly-readable text (scanned PDF, docx/pptx, error). */
  note?: string;
}

/** Cap `text` at READ_TEXT_CAP, appending a truncation note when it overruns. */
export function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= READ_TEXT_CAP) return { text, truncated: false };
  const clipped = text.slice(0, READ_TEXT_CAP);
  return {
    text: `${clipped}\n\n[... truncated at ${READ_TEXT_CAP.toLocaleString()} characters — the file is longer.]`,
    truncated: true,
  };
}

/** Decode UTF-8 bytes to a string (tolerant — invalid sequences become U+FFFD). */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** The one entry point the service calls. */
export async function extractAttachmentText(args: {
  mediaType: string;
  filename: string;
  bytes: Uint8Array;
}): Promise<ExtractResult> {
  const type = args.mediaType.trim().toLowerCase();

  if (type === MEDIA.txt || type === MEDIA.md || type === MEDIA.csv) {
    const { text, truncated } = capText(decodeUtf8(args.bytes));
    return { ok: true, text, truncated };
  }

  if (type === MEDIA.xlsx) {
    return extractXlsx(args.bytes);
  }

  if (type === MEDIA.pdf) {
    return extractPdf(args.bytes);
  }

  if (type === MEDIA.docx) {
    return {
      ok: false,
      note: "This is a Word (.docx) document — its formatted contents can't be read as plain text here. Enable the Office analysis lane, or ask the user to save it as a PDF or paste the text.",
    };
  }

  return {
    ok: false,
    note: `Pebble can't read the contents of a "${args.mediaType || "unknown"}" file as text.`,
  };
}

/** xlsx → sheet-by-sheet CSV. Each sheet is prefixed with a `## <name>` header. */
export async function extractXlsx(bytes: Uint8Array): Promise<ExtractResult> {
  let ExcelJS: typeof import("exceljs");
  try {
    ExcelJS = (await import("exceljs")).default ?? (await import("exceljs"));
  } catch {
    return { ok: false, note: "The spreadsheet reader is unavailable in this environment." };
  }
  try {
    const wb = new ExcelJS.Workbook();
    // exceljs wants a Node Buffer / ArrayBuffer.
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    const sheets: string[] = [];
    wb.eachSheet((ws) => {
      const rows: string[] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        rows.push(rowToCsv(row.values));
      });
      sheets.push(`## ${ws.name}\n${rows.join("\n")}`);
    });
    if (sheets.length === 0) {
      return { ok: false, note: "The spreadsheet appears to be empty." };
    }
    const { text, truncated } = capText(sheets.join("\n\n"));
    return { ok: true, text, truncated };
  } catch {
    return { ok: false, note: "That spreadsheet could not be read — it may be corrupted." };
  }
}

/**
 * exceljs `row.values` is a 1-based sparse array (index 0 is unused). Render one
 * CSV line, quoting cells that contain commas/quotes/newlines.
 */
function rowToCsv(values: unknown): string {
  const arr = Array.isArray(values) ? values.slice(1) : [];
  return arr.map((v) => csvCell(cellToString(v))).join(",");
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    // Rich text / hyperlink / formula result objects.
    const rec = v as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
    if (typeof rec.result === "string" || typeof rec.result === "number") return String(rec.result);
    if (rec.richText && Array.isArray(rec.richText)) {
      return (rec.richText as Array<{ text?: unknown }>).map((r) => String(r.text ?? "")).join("");
    }
    if (v instanceof Date) return v.toISOString();
    return "";
  }
  return String(v);
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** pdf → embedded text via unpdf; near-empty text is treated as scanned. */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractResult> {
  let extractText: (typeof import("unpdf"))["extractText"];
  try {
    ({ extractText } = await import("unpdf"));
  } catch {
    return { ok: false, note: "The PDF reader is unavailable in this environment." };
  }
  try {
    const { text } = await extractText(bytes, { mergePages: true });
    const merged = (Array.isArray(text) ? text.join("\n") : text ?? "").trim();
    if (merged.replace(/\s/g, "").length < 16) {
      return {
        ok: false,
        note: "This PDF appears to be scanned (no embedded text). Attach it directly to a message so Pebble can read it with vision.",
      };
    }
    const { text: capped, truncated } = capText(merged);
    return { ok: true, text: capped, truncated };
  } catch {
    return { ok: false, note: "That PDF could not be read — it may be corrupted or image-only." };
  }
}
