import "server-only";

import { createHash } from "node:crypto";
import { extname } from "node:path";
import {
  ChatSessionOwnershipError,
  findChatAttachmentBySha256,
  getOrCreateChatSession,
  insertChatAttachment,
  type Db,
} from "@pebble/db";
import type { StorageAdapter } from "@pebble/worker";
import { PDFDocument } from "pdf-lib";

/**
 * File-upload plumbing behind `app/api/chat/attachments` (Chat overhaul WP7)
 * — factored out of the route handler so it is unit-testable without a real
 * multipart `Request` (mirrors `chat-runtime.ts`/`chat-agent.ts`'s split: the
 * route file stays a thin auth + `FormData` parse wrapper; everything with a
 * decision to make lives here).
 *
 * `handleAttachmentUpload` is the one entry point the route calls: it
 * validates the WHOLE batch (allowlist + size caps + PDF page count) BEFORE
 * writing anything, so one bad file in a multi-file request refuses the
 * entire request rather than partially attaching the good ones. Only after
 * validation does it touch storage/the DB, and only then per-file, in order.
 */

// ─── Caps ────────────────────────────────────────────────────────────────────

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB
export const MAX_FILES_PER_REQUEST = 4;
/** Claude's document limit — a PDF over this many pages is refused outright. */
export const MAX_PDF_PAGES = 100;

export interface CapCheckInput {
  sizeBytes: number;
}

export interface CapCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Batch-level caps (spec WP7 §2): at most `MAX_FILES_PER_REQUEST` files, none
 * over `MAX_FILE_BYTES`. Pure and synchronous so it is testable without IO.
 */
export function checkCaps(files: readonly CapCheckInput[]): CapCheckResult {
  if (files.length === 0) {
    return { ok: false, reason: "No files were attached." };
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return { ok: false, reason: `Up to ${MAX_FILES_PER_REQUEST} files per message.` };
  }
  const tooBig = files.find((f) => f.sizeBytes > MAX_FILE_BYTES);
  if (tooBig) {
    return { ok: false, reason: "Files must be 20MB or smaller." };
  }
  return { ok: true };
}

// ─── Allowlist ───────────────────────────────────────────────────────────────

/** 'READY' — the agent can read it directly. 'OFFICE_PENDING' — a later WP's skills lane converts it first. */
export type AttachmentStatus = "READY" | "OFFICE_PENDING";

interface AllowlistEntry {
  status: AttachmentStatus;
  /** Accepted extensions (lowercase, with the leading dot) for this media type. */
  extensions: readonly string[];
}

const ALLOWLIST: Record<string, AllowlistEntry> = {
  "application/pdf": { status: "READY", extensions: [".pdf"] },
  "image/png": { status: "READY", extensions: [".png"] },
  "image/jpeg": { status: "READY", extensions: [".jpg", ".jpeg"] },
  "image/webp": { status: "READY", extensions: [".webp"] },
  "image/gif": { status: "READY", extensions: [".gif"] },
  "text/plain": { status: "READY", extensions: [".txt"] },
  "text/markdown": { status: "READY", extensions: [".md", ".markdown"] },
  "text/csv": { status: "READY", extensions: [".csv"] },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    status: "OFFICE_PENDING",
    extensions: [".xlsx"],
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    status: "OFFICE_PENDING",
    extensions: [".docx"],
  },
};

export interface AllowlistResult {
  ok: boolean;
  status?: AttachmentStatus;
  reason?: string;
}

/**
 * Allowlist check by media type + filename extension (spec WP7 §2). Both must
 * agree: the media type must be one of the registered types, AND the
 * filename's extension must be one this codebase associates with it — a
 * mismatch (e.g. a `.exe` sent with `mediaType: "application/pdf"`) is
 * rejected just like an unlisted media type. Pure and synchronous.
 */
export function checkAllowlist(mediaType: string, filename: string): AllowlistResult {
  const normalizedType = mediaType.trim().toLowerCase();
  const entry = ALLOWLIST[normalizedType];
  if (!entry) {
    return {
      ok: false,
      reason: `"${mediaType || "unknown file type"}" isn't supported. Attach a PDF, image, text/markdown/CSV, or Office (xlsx/docx) file.`,
    };
  }
  const ext = extname(filename).toLowerCase();
  if (!entry.extensions.includes(ext)) {
    return {
      ok: false,
      reason: `"${filename}" doesn't look like a ${normalizedType} file (expected ${entry.extensions.join(" or ")}).`,
    };
  }
  return { ok: true, status: entry.status };
}

// ─── Key derivation ──────────────────────────────────────────────────────────

/** Hex sha256 of the exact bytes being uploaded — the per-user dedup key. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Strip any path components and replace anything outside a safe charset with
 * `_`, so the filename is safe to embed directly in a storage key. Collapses
 * runs of `_` and caps length — defensive against both path traversal and a
 * pathologically long filename.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_{2,}/g, "_");
  const trimmed = cleaned.replace(/^_+|_+$/g, "");
  return (trimmed.length > 0 ? trimmed : "file").slice(0, 180);
}

/**
 * Storage key for an uploaded attachment: `chat-uploads/<userId>/<sha256>/<sanitized filename>`.
 * Content-addressed under the user's own prefix — two uploads of the same
 * bytes by the same user land on the same key (see `findChatAttachmentBySha256`
 * dedup in `handleAttachmentUpload`); two different users never collide even
 * with identical content, since each gets their own prefix.
 */
export function attachmentStorageKey(userId: string, sha256: string, filename: string): string {
  return `chat-uploads/${userId}/${sha256}/${sanitizeFilename(filename)}`;
}

// ─── PDF page-count guard ────────────────────────────────────────────────────

export interface PdfPageCheckResult {
  ok: boolean;
  pageCount?: number;
  reason?: string;
}

/**
 * Load a PDF (tolerating encryption — we only need the page count, not to
 * decrypt content) and refuse it outright over `MAX_PDF_PAGES` (Claude's
 * document limit). A PDF that fails to parse is refused with a friendly
 * message rather than throwing.
 */
export async function checkPdfPageCount(bytes: Uint8Array): Promise<PdfPageCheckResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    return { ok: false, reason: "That PDF could not be read — it may be corrupted." };
  }
  const pageCount = doc.getPageCount();
  if (pageCount > MAX_PDF_PAGES) {
    return {
      ok: false,
      pageCount,
      reason: `That PDF has ${pageCount} pages — Pebble can only read PDFs up to ${MAX_PDF_PAGES} pages.`,
    };
  }
  return { ok: true, pageCount };
}

// ─── The upload handler ──────────────────────────────────────────────────────

export interface UploadFileInput {
  filename: string;
  mediaType: string;
  bytes: Buffer;
}

export interface UploadedAttachment {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  pageCount: number | null;
}

export interface HandleUploadDeps {
  db: Db;
  storage: StorageAdapter;
}

export interface HandleUploadArgs {
  sessionId: string;
  userId: string;
  files: UploadFileInput[];
}

export type HandleUploadResult =
  | { ok: true; attachments: UploadedAttachment[] }
  | { ok: false; status: number; error: string; message: string };

/**
 * Validate + persist one upload batch. Two passes on purpose:
 *   1. Validate EVERY file (caps, allowlist, PDF page count) — no IO beyond
 *      reading the PDF's own page count, which is cheap relative to a
 *      storage write. Any failure here refuses the whole batch.
 *   2. Resolve the session (get-or-create, owner-checked) and only then write
 *      each file to storage (content-deduped per user) and insert its row.
 *
 * `sessionId` may be brand-new (created under `userId`) or an existing
 * session the caller owns; a `sessionId` owned by a DIFFERENT user 404s,
 * matching `runAgentTurn`'s session-ownership contract.
 */
export async function handleAttachmentUpload(
  deps: HandleUploadDeps,
  args: HandleUploadArgs,
): Promise<HandleUploadResult> {
  const { db, storage } = deps;
  const { sessionId, userId, files } = args;

  const capCheck = checkCaps(files.map((f) => ({ sizeBytes: f.bytes.byteLength })));
  if (!capCheck.ok) {
    return { ok: false, status: 413, error: "too_large", message: capCheck.reason! };
  }

  const prepared: Array<{
    file: UploadFileInput;
    status: AttachmentStatus;
    sha256: string;
    pageCount: number | null;
  }> = [];
  for (const file of files) {
    const allow = checkAllowlist(file.mediaType, file.filename);
    if (!allow.ok) {
      return { ok: false, status: 415, error: "unsupported_type", message: allow.reason! };
    }

    let pageCount: number | null = null;
    if (file.mediaType.trim().toLowerCase() === "application/pdf") {
      const pdfCheck = await checkPdfPageCount(file.bytes);
      if (!pdfCheck.ok) {
        return { ok: false, status: 413, error: "pdf_too_long", message: pdfCheck.reason! };
      }
      pageCount = pdfCheck.pageCount ?? null;
    }

    prepared.push({ file, status: allow.status!, sha256: sha256Hex(file.bytes), pageCount });
  }

  try {
    await getOrCreateChatSession(db, { sessionId, userId });
  } catch (err) {
    if (err instanceof ChatSessionOwnershipError) {
      return { ok: false, status: 404, error: "session_not_found", message: "Session not found." };
    }
    throw err;
  }

  const attachments: UploadedAttachment[] = [];
  for (const { file, status, sha256, pageCount } of prepared) {
    const existing = await findChatAttachmentBySha256(db, { userId, sha256 });
    const storageUri = existing
      ? existing.storageUri
      : (
          await storage.put(
            attachmentStorageKey(userId, sha256, file.filename),
            file.bytes,
            file.mediaType,
          )
        ).uri;

    const row = await insertChatAttachment(db, {
      sessionId,
      userId,
      filename: file.filename,
      mediaType: file.mediaType,
      sizeBytes: file.bytes.byteLength,
      sha256,
      storageUri,
      pageCount,
      status,
    });

    attachments.push({
      id: row.id,
      filename: row.filename,
      mediaType: row.mediaType,
      sizeBytes: row.sizeBytes,
      pageCount: row.pageCount,
    });
  }

  return { ok: true, attachments };
}
