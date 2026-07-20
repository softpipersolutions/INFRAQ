import "server-only";

import { createHash } from "node:crypto";
import type {
  AnalyzeOfficeResult,
  AttachmentListItem,
  AttachmentServices,
  GenerateFileResult,
  OfficeFormat,
  ReadAttachmentResult,
  SkillsLane,
} from "@pebble/ai";
import { OFFICE_FORMATS } from "@pebble/ai";
import {
  getChatAttachment,
  insertChatAttachment,
  listSessionAttachments,
  type ChatAttachmentRow,
  type Db,
} from "@pebble/db";
import type { StorageAdapter } from "@pebble/worker";
import { attachmentStorageKey } from "./chat-attachments";
import { extractAttachmentText } from "./attachment-extract";

/**
 * `AttachmentServices` (the WP8 re-read + Office lane surface) implemented over
 * the same owner-scoped attachment repo the upload/serve routes use plus the
 * env-selected storage adapter and (optionally) the Anthropic skills lane.
 *
 * Owner + session scoping is enforced twice: every repo read filters on the
 * acting `userId`, and `readAttachment`/`analyzeOfficeFile`/`generateFile`
 * additionally require the row's `session_id` to equal the bound session, so a
 * tool can never reach across sessions even with a valid foreign id.
 *
 * The skills lane is nullable: when the flag is off it is `null` and the two
 * office methods are never composed as tools (the caller gates that), so they
 * are only ever reached with a live lane.
 */
export interface AttachmentServicesDeps {
  db: Db;
  storage: StorageAdapter;
  userId: string;
  /** Null when PEBBLE_SKILLS_LANE is off / no key — office methods then unused. */
  skillsLane: SkillsLane | null;
}

class AttachmentServicesImpl implements AttachmentServices {
  private readonly db: Db;
  private readonly storage: StorageAdapter;
  private readonly userId: string;
  private readonly skillsLane: SkillsLane | null;

  constructor(deps: AttachmentServicesDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.userId = deps.userId;
    this.skillsLane = deps.skillsLane;
  }

  async listAttachments(sessionId: string): Promise<AttachmentListItem[]> {
    const rows = await listSessionAttachments(this.db, { sessionId, userId: this.userId });
    return rows.map((r) => ({
      attachmentId: r.id,
      filename: r.filename,
      mediaType: r.mediaType,
      sizeBytes: r.sizeBytes,
      pageCount: r.pageCount,
      status: r.status,
    }));
  }

  async readAttachment(sessionId: string, attachmentId: string): Promise<ReadAttachmentResult> {
    const row = await this.resolveOwned(sessionId, attachmentId);
    if (!row) {
      return {
        ok: false,
        attachmentId,
        filename: "",
        mediaType: "",
        note: "That attachment was not found in this session.",
      };
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.storage.get(row.storageUri);
    } catch {
      return {
        ok: false,
        attachmentId,
        filename: row.filename,
        mediaType: row.mediaType,
        note: "The stored file could not be read back from storage.",
      };
    }

    const extracted = await extractAttachmentText({
      mediaType: row.mediaType,
      filename: row.filename,
      bytes,
    });
    return {
      ok: extracted.ok,
      attachmentId,
      filename: row.filename,
      mediaType: row.mediaType,
      text: extracted.text,
      truncated: extracted.truncated,
      note: extracted.note,
    };
  }

  async analyzeOfficeFile(
    sessionId: string,
    attachmentId: string,
    instruction: string,
  ): Promise<AnalyzeOfficeResult> {
    if (!this.skillsLane) {
      return { ok: false, error: "Office analysis is not enabled." };
    }
    const row = await this.resolveOwned(sessionId, attachmentId);
    if (!row) return { ok: false, error: "That attachment was not found in this session." };

    let bytes: Uint8Array;
    try {
      bytes = await this.storage.get(row.storageUri);
    } catch {
      return { ok: false, filename: row.filename, error: "The stored file could not be read back from storage." };
    }

    try {
      const analysis = await this.skillsLane.analyzeOfficeFile({
        bytes,
        filename: row.filename,
        mediaType: row.mediaType,
        instruction,
      });
      return { ok: true, filename: row.filename, analysis };
    } catch (err) {
      return {
        ok: false,
        filename: row.filename,
        error: err instanceof Error ? err.message : "Office analysis failed.",
      };
    }
  }

  async generateFile(
    sessionId: string,
    instruction: string,
    format: OfficeFormat,
  ): Promise<GenerateFileResult> {
    if (!this.skillsLane) {
      return { ok: false, error: "File generation is not enabled." };
    }

    let generated: { bytes: Uint8Array; filename: string; mediaType: string };
    try {
      generated = await this.skillsLane.generateOfficeFile({ instruction, format });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "File generation failed." };
    }

    try {
      const sha256 = createHash("sha256").update(generated.bytes).digest("hex");
      const key = attachmentStorageKey(this.userId, sha256, generated.filename);
      const { uri } = await this.storage.put(key, generated.bytes, generated.mediaType);
      const row = await insertChatAttachment(this.db, {
        sessionId,
        userId: this.userId,
        filename: generated.filename,
        mediaType: generated.mediaType,
        sizeBytes: generated.bytes.byteLength,
        sha256,
        storageUri: uri,
        pageCount: null,
        status: "GENERATED",
      });
      return {
        ok: true,
        attachmentId: row.id,
        filename: row.filename,
        mediaType: row.mediaType,
        draft: true,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Storing the generated file failed." };
    }
  }

  /** Owner + session scoped lookup: the row must belong to this user AND session. */
  private async resolveOwned(sessionId: string, attachmentId: string): Promise<ChatAttachmentRow | null> {
    const row = await getChatAttachment(this.db, { id: attachmentId, userId: this.userId });
    if (!row || row.sessionId !== sessionId) return null;
    return row;
  }
}

export function createAttachmentServices(deps: AttachmentServicesDeps): AttachmentServices {
  return new AttachmentServicesImpl(deps);
}

/** The media types the read/analyze tools recognise as Office (skills-lane) files. */
export const OFFICE_MEDIA_TYPES: ReadonlySet<string> = new Set(
  Object.values(OFFICE_FORMATS).map((f) => f.mediaType),
);
