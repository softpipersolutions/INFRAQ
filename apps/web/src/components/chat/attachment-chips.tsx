"use client";

import {
  AlertCircle,
  File,
  FileText,
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  Table2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { Menu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Composer attachment chips (Chat overhaul WP7): the optimistic pending-list
 * row above the composer, and the static "sent" row rendered inside a just-
 * sent user message bubble. Both share the same icon/size formatting.
 */

/** One file the composer is uploading/has uploaded for the NEXT send, not yet part of a sent message. */
export interface PendingAttachment {
  /** Client-generated id — stable across the upload's lifecycle, independent of the eventual server id. */
  clientId: string;
  /** Server-assigned `chat_attachments.id`, set once the upload finishes. */
  id: string | null;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  status: "uploading" | "done" | "error";
  errorMessage?: string;
}

/** `2.4 MB` / `340 KB` / `12 B` — binary (1024) units, one decimal above 1 unit. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

/** Icon by media type: images get the image glyph, spreadsheets a table, everything else a document. */
export function attachmentIconFor(mediaType: string): LucideIcon {
  const type = mediaType.trim().toLowerCase();
  if (type.startsWith("image/")) return ImageIcon;
  if (
    type === "text/csv" ||
    type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return Table2;
  }
  if (
    type === "application/pdf" ||
    type === "text/plain" ||
    type === "text/markdown" ||
    type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return FileText;
  }
  return File;
}

function truncateFilename(filename: string, max = 24): string {
  if (filename.length <= max) return filename;
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 && dot > filename.length - 6 ? filename.slice(dot) : "";
  const stem = ext ? filename.slice(0, dot) : filename;
  const keep = Math.max(4, max - ext.length - 1);
  return `${stem.slice(0, keep)}…${ext}`;
}

/** One pending-upload chip: icon, truncated name, size, and a spinner/error glyph/remove button by status. */
function PendingChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: (clientId: string) => void;
}) {
  const Icon = attachmentIconFor(attachment.mediaType);
  const isError = attachment.status === "error";
  const isUploading = attachment.status === "uploading";

  const chip = (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        isError ? "border-danger-border bg-danger-soft text-danger" : "border-border bg-surface text-ink-secondary"
      }`}
    >
      {isUploading ? (
        <Loader2 size={13} strokeWidth={2} className="shrink-0 animate-spin text-ink-muted" aria-hidden />
      ) : isError ? (
        <AlertCircle size={13} strokeWidth={2} className="shrink-0" aria-hidden />
      ) : (
        <Icon size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" aria-hidden />
      )}
      <span className="max-w-[10rem] truncate" title={attachment.filename}>
        {truncateFilename(attachment.filename)}
      </span>
      {!isUploading && !isError ? (
        <span className="text-ink-muted">{formatFileSize(attachment.sizeBytes)}</span>
      ) : null}
      <button
        type="button"
        aria-label={`Remove ${attachment.filename}`}
        onClick={() => onRemove(attachment.clientId)}
        className="ml-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
      >
        <X size={11} strokeWidth={2} aria-hidden />
      </button>
    </span>
  );

  return isError && attachment.errorMessage ? <Tooltip label={attachment.errorMessage}>{chip}</Tooltip> : chip;
}

/** The pending-attachments row above the composer — nothing rendered when the list is empty. */
export function PendingAttachmentsRow({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (clientId: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 border-t border-border px-3 pt-2">
      {attachments.map((a) => (
        <PendingChip key={a.clientId} attachment={a} onRemove={onRemove} />
      ))}
    </div>
  );
}

/** A single attached-file reference on an already-sent message. */
export interface SentFile {
  filename: string;
  mediaType: string;
  /** Authenticated download/preview link (`/api/chat/attachments/:id`). */
  url: string;
  /** The chat_attachments.id — derived from `url` when absent (for the ingestion handoff). */
  attachmentId?: string;
}

/** `/api/chat/attachments/<id>` → `<id>`; null when the url isn't the serve route. */
function attachmentIdFromUrl(url: string): string | null {
  const match = /\/api\/chat\/attachments\/([^/?#]+)/.exec(url);
  return match?.[1] ?? null;
}

/**
 * Static (non-interactive) file chips rendered inside a just-sent user message —
 * no spinner, no remove button. When `onSendToIngestion` is provided (an
 * admin/estimator viewing the thread), a PDF chip grows a small overflow menu
 * with "Send to ingestion" (WP8 §4).
 */
export function SentFileChipsRow({
  files,
  onSendToIngestion,
}: {
  files: SentFile[];
  /** Admin/estimator-only handler; when set, PDF chips show a "Send to ingestion" overflow menu. */
  onSendToIngestion?: (attachmentId: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
      {files.map((f, i) => {
        const Icon = attachmentIconFor(f.mediaType);
        const attachmentId = f.attachmentId ?? attachmentIdFromUrl(f.url);
        const canIngest =
          !!onSendToIngestion && !!attachmentId && f.mediaType.trim().toLowerCase() === "application/pdf";
        return (
          <span key={i} className="inline-flex items-center">
            <a
              href={f.url}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex items-center gap-1.5 border border-border-strong bg-surface px-2.5 py-1 text-xs text-ink-secondary transition hover:bg-surface-sunken ${
                canIngest ? "rounded-l-full" : "rounded-full"
              }`}
            >
              <Icon size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" aria-hidden />
              <span className="max-w-[10rem] truncate" title={f.filename}>
                {truncateFilename(f.filename)}
              </span>
            </a>
            {canIngest ? (
              <Menu
                trigger={
                  <button
                    type="button"
                    aria-label={`More actions for ${f.filename}`}
                    className="inline-flex h-[26px] items-center rounded-r-full border border-l-0 border-border-strong bg-surface px-1.5 text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
                  >
                    <MoreHorizontal size={13} strokeWidth={2} aria-hidden />
                  </button>
                }
                items={[
                  {
                    label: "Send to ingestion",
                    icon: Upload,
                    onSelect: () => onSendToIngestion!(attachmentId!),
                  },
                ]}
              />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
