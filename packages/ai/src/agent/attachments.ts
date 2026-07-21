import { tool, type Tool } from "ai";
import { z } from "zod";
import type { OfficeFormat } from "../skills-lane";
import type { ModuleToolset } from "./registry";

/**
 * The attachments toolset (Chat overhaul WP8) — a module-AGNOSTIC `ModuleToolset`
 * composed beside `module02Toolset` on every chat turn. It gives the agent a way
 * to RE-READ the files the user uploaded to this session after the fact, without
 * paying to re-embed them on the current message:
 *
 *   - `list_attachments` — the session's uploads (id, filename, type, size,
 *     pages, status), so the agent can name a file before reading it.
 *   - `read_attachment` — extracted TEXT for one attachment: txt/md/csv
 *     verbatim, xlsx as sheet-by-sheet CSV, a PDF's embedded text, or a note
 *     pointing at the office lane for docx/pptx and scanned PDFs.
 *
 * When the skills lane flag is ON two more tools are added (the flag is checked
 * by the CALLER, which only passes `skills`-backed services then), so with the
 * flag OFF these tools are entirely absent — no schema, no prompt cost:
 *
 *   - `analyze_office_file` — run Anthropic's code-execution + Office skill over
 *     an xlsx/docx/pptx and return the text analysis.
 *   - `generate_file` — produce a DRAFT working file (xlsx/docx/pptx) via the
 *     same lane, stored under the session; returns its attachment id. The output
 *     is explicitly a draft, NEVER an official document (official letterhead
 *     documents come only from `prepare_documents`).
 *
 * `sessionId` is bound here (never model-supplied) so a tool can only ever act
 * on the attachments of the session that owns the turn; the service layer
 * additionally owner-scopes every lookup.
 */

/** One uploaded file, as `list_attachments` returns it. */
export interface AttachmentListItem {
  attachmentId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  pageCount: number | null;
  status: string;
}

/** Result of `read_attachment` — extracted text, or a note when direct text isn't available. */
export interface ReadAttachmentResult {
  ok: boolean;
  attachmentId: string;
  filename: string;
  mediaType: string;
  /** The extracted text (present when ok and the file yielded text). */
  text?: string;
  /** True when `text` was capped (a truncation note is also appended to `text`). */
  truncated?: boolean;
  /** A human-readable note when there is no directly-readable text (scanned PDF, docx/pptx, error). */
  note?: string;
}

/** Result of `analyze_office_file`. */
export interface AnalyzeOfficeResult {
  ok: boolean;
  filename?: string;
  analysis?: string;
  error?: string;
}

/** Result of `generate_file` — the stored draft's attachment id + filename, or an error. */
export interface GenerateFileResult {
  ok: boolean;
  attachmentId?: string;
  filename?: string;
  mediaType?: string;
  /** Always true on success — surfaced to the UI so the download card can caption it. */
  draft?: boolean;
  error?: string;
}

/** The service surface the attachments tools call — implemented in apps/web against db + storage + the skills lane. */
export interface AttachmentServices {
  listAttachments(sessionId: string): Promise<AttachmentListItem[]>;
  readAttachment(sessionId: string, attachmentId: string): Promise<ReadAttachmentResult>;
  /** Only reached when the skills lane is enabled (the caller gates composition). */
  analyzeOfficeFile?(sessionId: string, attachmentId: string, instruction: string): Promise<AnalyzeOfficeResult>;
  /** Only reached when the skills lane is enabled. */
  generateFile?(sessionId: string, instruction: string, format: OfficeFormat): Promise<GenerateFileResult>;
}

const OFFICE_FORMAT_ENUM = ["xlsx", "docx", "pptx"] as const;

export function attachmentsToolset(
  services: AttachmentServices,
  opts: { sessionId: string; skillsEnabled?: boolean },
): ModuleToolset {
  const { sessionId, skillsEnabled = false } = opts;

  const tools: Record<string, Tool> = {
    list_attachments: tool({
      description:
        "List the files the user has uploaded to THIS chat session (id, filename, type, size, page count, status). Use this to see what is available before reading a specific file with read_attachment.",
      inputSchema: z.object({}),
      execute: () => services.listAttachments(sessionId),
    }),

    read_attachment: tool({
      description:
        "Re-read the extracted TEXT of one uploaded file by its attachmentId (from list_attachments). Returns text/markdown/CSV verbatim, a spreadsheet as sheet-by-sheet CSV, or a PDF's embedded text. A scanned PDF or an Office doc/deck returns a note explaining how to proceed (attach it to a message for vision, or use analyze_office_file when available). Text is capped with a truncation note.",
      inputSchema: z.object({ attachmentId: z.string().min(1) }),
      execute: ({ attachmentId }) => services.readAttachment(sessionId, attachmentId),
    }),
  };

  if (skillsEnabled) {
    tools.analyze_office_file = tool({
      description:
        "Analyze an uploaded Office file (xlsx/docx/pptx) that cannot be read as plain text: runs Anthropic's code-execution container with the built-in Office skill over the file and returns a text analysis. Pass the attachmentId (from list_attachments) and a clear instruction of what to extract or check.",
      inputSchema: z.object({
        attachmentId: z.string().min(1),
        instruction: z.string().min(1),
      }),
      execute: ({ attachmentId, instruction }) => services.analyzeOfficeFile!(sessionId, attachmentId, instruction),
    });

    tools.generate_file = tool({
      description:
        "Generate a DRAFT working file (xlsx spreadsheet, docx document, or pptx deck) from an instruction, stored under this session and returned as a downloadable attachment. IMPORTANT: the output is a DRAFT working file for the user's convenience — it is NEVER an official Greenberg document. Official letterhead documents come only from prepare_documents on a LOCKED estimate. Say so when you hand over the file.",
      inputSchema: z.object({
        instruction: z.string().min(1),
        format: z.enum(OFFICE_FORMAT_ENUM),
      }),
      execute: ({ instruction, format }) => services.generateFile!(sessionId, instruction, format),
    });
  }

  return {
    id: "attachments",
    title: "Attachments — re-read + Office analysis/generation",
    promptFragment: skillsEnabled ? ATTACHMENTS_FRAGMENT_WITH_SKILLS : ATTACHMENTS_FRAGMENT,
    tools,
    policy: { confirmRequired: [], humanOnly: [] },
    // WP11 tool-search pilot — `list_attachments` is the HOT entry point: the
    // agent calls it to discover what the user uploaded before doing anything
    // file-related, so it must never be a tool-search miss. `read_attachment`
    // (and the flagged analyze/generate tools) are cold — expanded on demand.
    hotTools: ["list_attachments"],
  };
}

const ATTACHMENTS_FRAGMENT = `ATTACHMENTS
The user can upload files to a chat session. Files attached to the CURRENT message arrive as content you can already see. To re-read an EARLIER upload without asking the user to resend it, call list_attachments to see the session's files, then read_attachment to pull one file's text (txt/md/csv verbatim, a spreadsheet as CSV, a PDF's embedded text). A scanned PDF or an Office doc/deck returns a note — relay it to the user rather than guessing at contents.`;

const ATTACHMENTS_FRAGMENT_WITH_SKILLS = `${ATTACHMENTS_FRAGMENT}
For an Office file (xlsx/docx/pptx) whose contents you cannot read as text, use analyze_office_file with a clear instruction. When the user asks for a spreadsheet/document/deck, use generate_file — but always tell them the result is a DRAFT working file, not an official Greenberg document (official documents come only from prepare_documents on a LOCKED estimate).`;
