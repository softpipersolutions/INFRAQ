import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  getChatAttachment,
  listSessionAttachments,
  migrateDb,
  seedDatabase,
  upsertUser,
  type AppUser,
  type Db,
  type DbHandle,
} from "@pebble/db";
import { LocalStorageAdapter, type PutResult, type StorageAdapter } from "@pebble/worker";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachmentStorageKey,
  checkAllowlist,
  checkCaps,
  checkPdfPageCount,
  handleAttachmentUpload,
  MAX_FILE_BYTES,
  MAX_FILES_PER_REQUEST,
  MAX_PDF_PAGES,
  sanitizeFilename,
  sha256Hex,
  type UploadFileInput,
} from "../src/server/chat-attachments";

/**
 * Chat-attachment upload plumbing (Chat overhaul WP7). Split like
 * `chat-agent.test.ts`: pure-helper unit tests (no IO) plus a handful of
 * `handleAttachmentUpload` tests against an in-memory PGlite db + a
 * `LocalStorageAdapter` under a scratch temp dir — no HTTP, no real
 * `FormData`/`Request` (there is no app-route test pattern in this repo yet;
 * `route.ts` itself is a thin auth + parse wrapper with nothing left to unit
 * test once this module is covered).
 */

/** Build an in-memory PDF with `n` blank pages. */
async function buildPdf(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([200, 200]);
  return doc.save();
}

function file(filename: string, mediaType: string, bytes: string | Buffer | Uint8Array): UploadFileInput {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return { filename, mediaType, bytes: buf };
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe("checkCaps", () => {
  it("rejects an empty batch", () => {
    expect(checkCaps([]).ok).toBe(false);
  });

  it(`rejects more than ${MAX_FILES_PER_REQUEST} files`, () => {
    const files = Array.from({ length: MAX_FILES_PER_REQUEST + 1 }, () => ({ sizeBytes: 10 }));
    const result = checkCaps(files);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(new RegExp(String(MAX_FILES_PER_REQUEST)));
  });

  it("accepts exactly the cap", () => {
    const files = Array.from({ length: MAX_FILES_PER_REQUEST }, () => ({ sizeBytes: 10 }));
    expect(checkCaps(files).ok).toBe(true);
  });

  it("rejects a file over 20MB", () => {
    const result = checkCaps([{ sizeBytes: MAX_FILE_BYTES + 1 }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/20MB/);
  });

  it("accepts a file exactly at the 20MB boundary", () => {
    expect(checkCaps([{ sizeBytes: MAX_FILE_BYTES }]).ok).toBe(true);
  });
});

describe("checkAllowlist", () => {
  it.each([
    ["application/pdf", "proposal.pdf"],
    ["image/png", "photo.PNG"],
    ["image/jpeg", "photo.jpg"],
    ["image/jpeg", "photo.jpeg"],
    ["image/webp", "photo.webp"],
    ["image/gif", "photo.gif"],
    ["text/plain", "notes.txt"],
    ["text/markdown", "notes.md"],
    ["text/csv", "boq.csv"],
  ])("accepts %s with matching extension %s as READY", (mediaType, filename) => {
    const result = checkAllowlist(mediaType, filename);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("READY");
  });

  it("accepts xlsx as OFFICE_PENDING", () => {
    const result = checkAllowlist(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "quote.xlsx",
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("OFFICE_PENDING");
  });

  it("accepts docx as OFFICE_PENDING", () => {
    const result = checkAllowlist(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "letter.docx",
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("OFFICE_PENDING");
  });

  it("rejects an unlisted media type", () => {
    const result = checkAllowlist("application/x-msdownload", "tool.exe");
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("rejects a mismatched extension for a listed media type", () => {
    // A renamed executable declaring itself as a PDF — extension must agree.
    const result = checkAllowlist("application/pdf", "totally-safe.exe");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty/missing media type", () => {
    expect(checkAllowlist("", "file.pdf").ok).toBe(false);
  });
});

describe("sanitizeFilename", () => {
  it("strips POSIX and Windows path components", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
  });

  it("replaces unsafe characters and collapses repeats", () => {
    expect(sanitizeFilename("my report (final)!!.pdf")).toBe("my_report_final_.pdf");
  });

  it("falls back to 'file' for an empty/entirely-unsafe name", () => {
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename("///")).toBe("file");
  });

  it("caps an absurdly long filename", () => {
    const long = `${"a".repeat(300)}.pdf`;
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(180);
  });
});

describe("attachmentStorageKey", () => {
  it("derives chat-uploads/<userId>/<sha256>/<sanitized filename>", () => {
    expect(attachmentStorageKey("user-1", "abc123", "My File.pdf")).toBe(
      "chat-uploads/user-1/abc123/My_File.pdf",
    );
  });

  it("sanitizes the filename component (no path traversal)", () => {
    expect(attachmentStorageKey("user-1", "abc123", "../../etc/passwd")).toBe(
      "chat-uploads/user-1/abc123/passwd",
    );
  });
});

describe("sha256Hex", () => {
  it("matches node:crypto for the same bytes", () => {
    const bytes = Buffer.from("deterministic content for hashing");
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("differs for different bytes", () => {
    expect(sha256Hex(Buffer.from("a"))).not.toBe(sha256Hex(Buffer.from("b")));
  });
});

describe("checkPdfPageCount", () => {
  it("reports the exact page count under the cap", async () => {
    const result = await checkPdfPageCount(await buildPdf(3));
    expect(result).toEqual({ ok: true, pageCount: 3 });
  });

  it(`rejects a PDF over ${MAX_PDF_PAGES} pages`, async () => {
    const result = await checkPdfPageCount(await buildPdf(MAX_PDF_PAGES + 1));
    expect(result.ok).toBe(false);
    expect(result.pageCount).toBe(MAX_PDF_PAGES + 1);
    expect(result.reason).toMatch(new RegExp(String(MAX_PDF_PAGES)));
  });

  it(`accepts a PDF at exactly ${MAX_PDF_PAGES} pages`, async () => {
    const result = await checkPdfPageCount(await buildPdf(MAX_PDF_PAGES));
    expect(result.ok).toBe(true);
  });

  it("refuses (rather than throws) on unparsable bytes", async () => {
    const result = await checkPdfPageCount(Buffer.from("not a pdf"));
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

// ─── handleAttachmentUpload (PGlite + LocalStorageAdapter) ──────────────────

/** Counts `put` calls so dedup tests can assert storage was written exactly once. */
class CountingStorage implements StorageAdapter {
  putCalls = 0;
  constructor(private readonly inner: StorageAdapter) {}
  async put(key: string, bytes: Buffer | Uint8Array, contentType: string): Promise<PutResult> {
    this.putCalls += 1;
    return this.inner.put(key, bytes, contentType);
  }
  signedUrl(uri: string, ttlSeconds: number): Promise<string> {
    return this.inner.signedUrl(uri, ttlSeconds);
  }
  get(uri: string): Promise<Buffer> {
    return this.inner.get(uri);
  }
  keyToUri(key: string): string {
    return this.inner.keyToUri(key);
  }
}

const UPLOADER: AppUser = {
  firebaseUid: "attach-uploader",
  email: "uploader@greenberg.test",
  displayName: "Uploader",
  role: "estimator",
  active: true,
};

const OTHER_USER: AppUser = {
  firebaseUid: "attach-other",
  email: "other@greenberg.test",
  displayName: "Other",
  role: "estimator",
  active: true,
};

describe("handleAttachmentUpload", () => {
  let handle: DbHandle;
  let db: Db;
  let storage: CountingStorage;

  beforeAll(async () => {
    handle = await createDb({ pglite: true, pgliteDir: "memory://" });
    await migrateDb(handle);
    await seedDatabase(handle.db);
    db = handle.db as unknown as Db;
    await upsertUser(db, UPLOADER);
    await upsertUser(db, OTHER_USER);
    const dir = await mkdtemp(join(tmpdir(), "pebble-web-attachments-"));
    storage = new CountingStorage(new LocalStorageAdapter(dir));
  });

  afterAll(async () => {
    await handle.close();
  });

  it("uploads a single file, creating the session under the caller", async () => {
    const result = await handleAttachmentUpload(
      { db, storage },
      {
        sessionId: "attach-sess-1",
        userId: UPLOADER.firebaseUid,
        files: [file("notes.txt", "text/plain", "hello world")],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      filename: "notes.txt",
      mediaType: "text/plain",
      pageCount: null,
    });

    const stored = await getChatAttachment(db, {
      id: result.attachments[0]!.id,
      userId: UPLOADER.firebaseUid,
    });
    expect(stored?.status).toBe("READY");
    expect(stored?.storageUri.startsWith("file://")).toBe(true);
  });

  it("records a PDF's page count and OFFICE_PENDING status for xlsx", async () => {
    const pdfBytes = await buildPdf(5);
    const result = await handleAttachmentUpload(
      { db, storage },
      {
        sessionId: "attach-sess-2",
        userId: UPLOADER.firebaseUid,
        files: [
          file("boq.pdf", "application/pdf", pdfBytes),
          file(
            "quote.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "fake xlsx bytes",
          ),
        ],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments[0]).toMatchObject({ filename: "boq.pdf", pageCount: 5 });
    expect(result.attachments[1]).toMatchObject({ filename: "quote.xlsx", pageCount: null });

    const rows = await listSessionAttachments(db, {
      sessionId: "attach-sess-2",
      userId: UPLOADER.firebaseUid,
    });
    expect(rows.map((r) => r.status)).toEqual(["READY", "OFFICE_PENDING"]);
  });

  it("refuses the WHOLE batch (415) on one unsupported file, persisting nothing", async () => {
    const before = await listSessionAttachments(db, {
      sessionId: "attach-sess-3",
      userId: UPLOADER.firebaseUid,
    });
    expect(before).toEqual([]);

    const result = await handleAttachmentUpload(
      { db, storage },
      {
        sessionId: "attach-sess-3",
        userId: UPLOADER.firebaseUid,
        files: [file("notes.txt", "text/plain", "ok"), file("virus.exe", "application/x-msdownload", "bad")],
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(415);

    // Nothing was persisted for this session — including the file BEFORE the
    // bad one in the batch.
    const after = await listSessionAttachments(db, {
      sessionId: "attach-sess-3",
      userId: UPLOADER.firebaseUid,
    });
    expect(after).toEqual([]);
  });

  it("refuses a PDF over the page cap (413), persisting nothing", async () => {
    const hugePdf = await buildPdf(MAX_PDF_PAGES + 1);
    const result = await handleAttachmentUpload(
      { db, storage },
      {
        sessionId: "attach-sess-4",
        userId: UPLOADER.firebaseUid,
        files: [file("huge.pdf", "application/pdf", hugePdf)],
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(413);
    expect(
      await listSessionAttachments(db, { sessionId: "attach-sess-4", userId: UPLOADER.firebaseUid }),
    ).toEqual([]);
  });

  it("dedups identical content for the same user: two rows, one storage write, same storageUri", async () => {
    const before = storage.putCalls;
    const bytes = "same bytes twice";

    const first = await handleAttachmentUpload(
      { db, storage },
      {
        sessionId: "attach-sess-dedup-a",
        userId: UPLOADER.firebaseUid,
        files: [file("dup.txt", "text/plain", bytes)],
      },
    );
    const second = await handleAttachmentUpload(
      { db, storage },
      {
        sessionId: "attach-sess-dedup-b",
        userId: UPLOADER.firebaseUid,
        files: [file("dup.txt", "text/plain", bytes)],
      },
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.attachments[0]!.id).not.toBe(second.attachments[0]!.id);
    expect(storage.putCalls).toBe(before + 1); // only the FIRST upload actually wrote to storage

    const firstRow = await getChatAttachment(db, {
      id: first.attachments[0]!.id,
      userId: UPLOADER.firebaseUid,
    });
    const secondRow = await getChatAttachment(db, {
      id: second.attachments[0]!.id,
      userId: UPLOADER.firebaseUid,
    });
    expect(secondRow?.storageUri).toBe(firstRow?.storageUri);
  });

  it("404s a sessionId owned by a different user", async () => {
    const owned = await handleAttachmentUpload(
      { db, storage },
      {
        sessionId: "attach-sess-foreign",
        userId: UPLOADER.firebaseUid,
        files: [file("mine.txt", "text/plain", "mine")],
      },
    );
    expect(owned.ok).toBe(true);

    const intruding = await handleAttachmentUpload(
      { db, storage },
      {
        sessionId: "attach-sess-foreign",
        userId: OTHER_USER.firebaseUid,
        files: [file("theirs.txt", "text/plain", "theirs")],
      },
    );
    expect(intruding.ok).toBe(false);
    if (intruding.ok) return;
    expect(intruding.status).toBe(404);
  });

  it("refuses an oversized batch (413) before touching storage or the session", async () => {
    const oversized = Buffer.alloc(MAX_FILE_BYTES + 1, 1);
    const result = await handleAttachmentUpload(
      { db, storage },
      {
        sessionId: "attach-sess-oversize",
        userId: UPLOADER.firebaseUid,
        files: [file("big.pdf", "application/pdf", oversized)],
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(413);
    expect(
      await listSessionAttachments(db, { sessionId: "attach-sess-oversize", userId: UPLOADER.firebaseUid }),
    ).toEqual([]);
  });
});
