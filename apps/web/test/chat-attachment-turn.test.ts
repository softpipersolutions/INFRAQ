import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_TOKEN_LIMIT,
  buildAttachmentUserContent,
  buildOfficePendingNote,
  checkAttachmentCost,
  classifyAttachment,
  estimateAttachmentTokens,
  toTurnAttachment,
  userFilePartsFor,
  type TurnAttachment,
} from "../src/server/chat-attachment-turn";

/**
 * Pure attachment-turn helpers (WP8): classification, the pre-flight cost guard
 * math + refusal, the multi-part message assembly (file parts last so the
 * message-level cache breakpoint lands on the final block), the OFFICE_PENDING
 * note, and the persisted file-part shape.
 */

function meta(over: Partial<TurnAttachment> = {}): TurnAttachment {
  return toTurnAttachment({
    id: over.id ?? "a1",
    filename: over.filename ?? "file.bin",
    mediaType: over.mediaType ?? "application/octet-stream",
    sizeBytes: over.sizeBytes ?? 100,
    pageCount: over.pageCount ?? null,
    status: over.status ?? "READY",
  });
}

describe("classifyAttachment", () => {
  it.each([
    ["application/pdf", "pdf"],
    ["image/png", "image"],
    ["image/jpeg", "image"],
    ["text/plain", "text"],
    ["text/markdown", "text"],
    ["text/csv", "text"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "office"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "office"],
    ["application/zip", "other"],
  ])("%s → %s", (mediaType, kind) => {
    expect(classifyAttachment({ id: "x", filename: "f", mediaType, sizeBytes: 1, pageCount: null, status: "READY" })).toBe(kind);
  });

  it("treats an OFFICE_PENDING status as office regardless of media type", () => {
    expect(classifyAttachment({ id: "x", filename: "f", mediaType: "application/octet-stream", sizeBytes: 1, pageCount: null, status: "OFFICE_PENDING" })).toBe("office");
  });
});

describe("cost guard math", () => {
  it("pdf = pages × 2500, image = 1600, text = bytes/4, office = 0", () => {
    const atts = [
      meta({ mediaType: "application/pdf", pageCount: 4 }), // 10_000
      meta({ mediaType: "image/png" }), // 1_600
      meta({ mediaType: "text/csv", sizeBytes: 400 }), // 100
      meta({ mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 999999 }), // 0
    ];
    expect(estimateAttachmentTokens(atts)).toBe(10_000 + 1_600 + 100 + 0);
  });

  it("a pdf with no pageCount counts as 1 page", () => {
    expect(estimateAttachmentTokens([meta({ mediaType: "application/pdf", pageCount: null })])).toBe(2500);
  });

  it("passes under the limit", () => {
    const result = checkAttachmentCost([meta({ mediaType: "application/pdf", pageCount: 10 })]); // 25_000
    expect(result.ok).toBe(true);
    expect(result.estimatedTokens).toBe(25_000);
  });

  it("refuses over the limit and names the biggest file", () => {
    const atts = [
      meta({ mediaType: "image/png", filename: "small.png" }), // 1_600
      meta({ mediaType: "application/pdf", pageCount: 30, filename: "huge-boq.pdf" }), // 75_000
    ];
    const result = checkAttachmentCost(atts);
    expect(result.ok).toBe(false);
    expect(result.estimatedTokens).toBeGreaterThan(ATTACHMENT_TOKEN_LIMIT);
    expect(result.message).toContain("huge-boq.pdf");
  });

  it("accepts exactly at the limit boundary", () => {
    // 24 pages × 2500 = 60_000 == limit.
    const result = checkAttachmentCost([meta({ mediaType: "application/pdf", pageCount: 24 })]);
    expect(result.ok).toBe(true);
  });
});

describe("buildAttachmentUserContent", () => {
  it("no binary parts → plain string content (text + fenced text blocks)", () => {
    const atts = [meta({ mediaType: "text/csv", filename: "rates.csv" })];
    atts[0]!.text = "a,b\n1,2";
    const { content } = buildAttachmentUserContent({ text: "please read this", attachments: atts, skillsEnabled: false });
    expect(typeof content).toBe("string");
    expect(content).toContain("please read this");
    expect(content).toContain("rates.csv");
    expect(content).toContain("a,b");
  });

  it("with a PDF → an array whose LAST block is the file part (cache breakpoint lands there)", () => {
    const pdf = meta({ mediaType: "application/pdf", filename: "spec.pdf", pageCount: 2 });
    pdf.bytes = new Uint8Array([1, 2, 3]);
    const { content } = buildAttachmentUserContent({ text: "look", attachments: [pdf], skillsEnabled: false });
    expect(Array.isArray(content)).toBe(true);
    const arr = content as Array<{ type: string; mediaType?: string }>;
    expect(arr[0]!.type).toBe("text");
    const last = arr[arr.length - 1]!;
    expect(last.type).toBe("file");
    expect(last.mediaType).toBe("application/pdf");
  });

  it("images become file parts with their own media type", () => {
    const img = meta({ mediaType: "image/png", filename: "photo.png" });
    img.bytes = new Uint8Array([9]);
    const { content } = buildAttachmentUserContent({ text: "hi", attachments: [img], skillsEnabled: false });
    const arr = content as Array<{ type: string; mediaType?: string }>;
    expect(arr[arr.length - 1]).toMatchObject({ type: "file", mediaType: "image/png" });
  });

  it("emits an OFFICE note (skills off) and does not embed the office file", () => {
    const xlsx = meta({ mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "boq.xlsx", status: "OFFICE_PENDING" });
    const { content, officeNote } = buildAttachmentUserContent({ text: "check", attachments: [xlsx], skillsEnabled: false });
    expect(typeof content).toBe("string"); // no binary parts embedded
    expect(officeNote).toContain("boq.xlsx");
    expect(officeNote).toContain("not currently enabled");
  });

  it("emits an OFFICE note pointing at analyze_office_file when skills on", () => {
    const note = buildOfficePendingNote(
      [meta({ mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "scope.docx" })],
      true,
    );
    expect(note).toContain("analyze_office_file");
    expect(note).toContain("scope.docx");
  });

  it("no office files → null note", () => {
    expect(buildOfficePendingNote([], false)).toBeNull();
  });
});

describe("userFilePartsFor", () => {
  it("emits one v1 file part per attachment", () => {
    const parts = userFilePartsFor([
      meta({ id: "a1", filename: "a.pdf", mediaType: "application/pdf" }),
      meta({ id: "a2", filename: "b.png", mediaType: "image/png" }),
    ]);
    expect(parts).toEqual([
      { type: "file", filename: "a.pdf", mediaType: "application/pdf", attachmentId: "a1", v: 1 },
      { type: "file", filename: "b.png", mediaType: "image/png", attachmentId: "a2", v: 1 },
    ]);
  });
});
