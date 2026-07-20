import type { FilePart, ImagePart, TextPart, UserContent } from "ai";

/**
 * Pure helpers for threading uploaded attachments into a chat turn (WP8).
 *
 * These are deliberately free of DB/storage/`server-only` imports so the
 * cost-guard math and the multi-part message assembly are unit-testable in
 * isolation (see chat-attachment-turn.test.ts). `runAgentTurn` (chat-agent.ts)
 * resolves + owner-checks the attachment rows, loads their bytes/text, then
 * calls these to (a) refuse an over-budget batch before any model call and
 * (b) assemble the current user message's multi-part content.
 */

/** Pre-flight budget: refuse a batch whose estimated tokens exceed this. */
export const ATTACHMENT_TOKEN_LIMIT = 60_000;

/** Per-format token multipliers for the pre-flight estimate (spec WP8 §1). */
const PDF_TOKENS_PER_PAGE = 2500;
const IMAGE_TOKENS = 1600;
const TEXT_BYTES_PER_TOKEN = 4;

export type AttachmentKind = "pdf" | "image" | "text" | "office" | "other";

/** The office media types the skills lane covers (xlsx/docx/pptx). */
const OFFICE_MEDIA_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const TEXT_MEDIA_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);

/** The metadata a chat_attachments row contributes to a turn. */
export interface AttachmentMeta {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  pageCount: number | null;
  status: string;
  /** Where the bytes live — used to load content for embedding (server-side only). */
  storageUri?: string;
}

/** A resolved attachment for the turn, with its bytes/text loaded when relevant. */
export interface TurnAttachment extends AttachmentMeta {
  kind: AttachmentKind;
  /** Loaded for pdf/image (embedded as a file part). */
  bytes?: Uint8Array;
  /** Loaded for text/csv/md (appended as a fenced block). */
  text?: string;
}

/** Classify an attachment by media type + status. */
export function classifyAttachment(meta: AttachmentMeta): AttachmentKind {
  const type = meta.mediaType.trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (TEXT_MEDIA_TYPES.has(type)) return "text";
  if (meta.status === "OFFICE_PENDING" || OFFICE_MEDIA_TYPES.has(type)) return "office";
  return "other";
}

export function toTurnAttachment(meta: AttachmentMeta): TurnAttachment {
  return { ...meta, kind: classifyAttachment(meta) };
}

/** The token contribution of a single attachment for the pre-flight estimate. */
export function attachmentTokenContribution(a: TurnAttachment): number {
  switch (a.kind) {
    case "pdf":
      return (a.pageCount ?? 1) * PDF_TOKENS_PER_PAGE;
    case "image":
      return IMAGE_TOKENS;
    case "text":
      return Math.ceil(a.sizeBytes / TEXT_BYTES_PER_TOKEN);
    default:
      // Office/other files are NOT embedded on the message (they go through the
      // re-read/analyze tools), so they cost nothing against the message budget.
      return 0;
  }
}

/** Total estimated tokens for embedding a batch of attachments on the message. */
export function estimateAttachmentTokens(atts: readonly TurnAttachment[]): number {
  return atts.reduce((sum, a) => sum + attachmentTokenContribution(a), 0);
}

export interface AttachmentCostResult {
  ok: boolean;
  estimatedTokens: number;
  /** A friendly refusal message naming the biggest file (present when !ok). */
  message?: string;
}

/**
 * Pre-flight cost guard: refuse a batch whose estimated embedded tokens exceed
 * `ATTACHMENT_TOKEN_LIMIT`, naming the single biggest contributor so the user
 * knows which file to drop. Pure — the caller returns the friendly-error JSON.
 */
export function checkAttachmentCost(atts: readonly TurnAttachment[]): AttachmentCostResult {
  const estimatedTokens = estimateAttachmentTokens(atts);
  if (estimatedTokens <= ATTACHMENT_TOKEN_LIMIT) {
    return { ok: true, estimatedTokens };
  }
  const biggest = [...atts].sort(
    (a, b) => attachmentTokenContribution(b) - attachmentTokenContribution(a),
  )[0];
  const name = biggest?.filename ? `"${biggest.filename}"` : "one of the files";
  return {
    ok: false,
    estimatedTokens,
    message:
      `Those attachments are too large to read in one message ` +
      `(about ${estimatedTokens.toLocaleString()} tokens; the limit is ${ATTACHMENT_TOKEN_LIMIT.toLocaleString()}). ` +
      `The biggest is ${name}. Send fewer or smaller files, or ask me to read one at a time.`,
  };
}

/** Persisted file-part shape on a user message row (tolerant-reader `v:1`). */
export interface PersistedFilePart {
  type: "file";
  filename: string;
  mediaType: string;
  attachmentId: string;
  v: 1;
}

/** The file parts to persist on the user's chat_messages row (one per attachment). */
export function userFilePartsFor(atts: readonly TurnAttachment[]): PersistedFilePart[] {
  return atts.map((a) => ({
    type: "file",
    filename: a.filename,
    mediaType: a.mediaType,
    attachmentId: a.id,
    v: 1,
  }));
}

export interface BuiltUserMessage {
  /** The current user message content — a plain string when no binary parts, else a parts array. */
  content: UserContent;
  /** A system-side note about OFFICE_PENDING files, or null when there are none. */
  officeNote: string | null;
}

/**
 * Assemble the current user message's content from the typed text + resolved
 * attachments:
 *   - text/csv/md are appended to the text as fenced blocks (cheaper than
 *     document blocks);
 *   - PDFs and images become `file` content parts (the Anthropic provider maps
 *     an `application/pdf` file part to a document block and an `image/*` file
 *     part to an image block);
 *   - OFFICE_PENDING/office files are NOT embedded — they surface via the
 *     returned `officeNote` (and the re-read/analyze tools).
 *
 * The cache breakpoint (bp2) is applied by the caller as message-level
 * `providerOptions`; the Anthropic provider lands message-level cacheControl on
 * the LAST content block of a multi-part user message, so binary parts go last
 * (after the text part) and the breakpoint always sits on the final block.
 */
export function buildAttachmentUserContent(args: {
  text: string;
  attachments: readonly TurnAttachment[];
  skillsEnabled: boolean;
}): BuiltUserMessage {
  const { text, attachments, skillsEnabled } = args;

  const textSegments: string[] = [text];
  for (const a of attachments) {
    if (a.kind === "text" && typeof a.text === "string") {
      textSegments.push(`Attached file "${a.filename}" (${a.mediaType}):\n\`\`\`\n${a.text}\n\`\`\``);
    }
  }
  const combinedText = textSegments.filter((s) => s.length > 0).join("\n\n");

  const binaryParts: Array<FilePart | ImagePart> = [];
  for (const a of attachments) {
    if (!a.bytes) continue;
    if (a.kind === "pdf") {
      binaryParts.push({ type: "file", data: a.bytes, mediaType: "application/pdf", filename: a.filename });
    } else if (a.kind === "image") {
      binaryParts.push({ type: "file", data: a.bytes, mediaType: a.mediaType, filename: a.filename });
    }
  }

  const officeAttachments = attachments.filter((a) => a.kind === "office");
  const officeNote = buildOfficePendingNote(officeAttachments, skillsEnabled);

  if (binaryParts.length === 0) {
    // No binary parts — a plain string keeps the message-level cache breakpoint
    // on the single (text) block, exactly like a normal turn.
    return { content: combinedText, officeNote };
  }

  const textPart: TextPart = { type: "text", text: combinedText };
  return { content: [textPart, ...binaryParts], officeNote };
}

/** The OFFICE_PENDING system note, or null when there are no office files this turn. */
export function buildOfficePendingNote(
  officeAttachments: readonly TurnAttachment[],
  skillsEnabled: boolean,
): string | null {
  if (officeAttachments.length === 0) return null;
  const names = officeAttachments.map((a) => `"${a.filename}"`).join(", ");
  if (skillsEnabled) {
    return (
      `The user attached Office file(s) ${names} that cannot be embedded as text. ` +
      `Use analyze_office_file (with the attachmentId from list_attachments) to read them.`
    );
  }
  return (
    `The user attached Office file(s) ${names} (Word/Excel). Office analysis is not currently enabled, ` +
    `so you cannot read their contents. Tell the user this plainly and suggest they save the file as a PDF or CSV, ` +
    `or paste the relevant text.`
  );
}
