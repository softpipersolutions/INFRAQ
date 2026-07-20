import type { UIMessage } from "ai";

/**
 * The shape `trpc.chat.history` rows need for hydration — a structural subset
 * of the router's actual output (which also carries `lane`/`model`/`createdAt`;
 * extra fields are ignored here).
 */
export interface ChatHistoryRow {
  id: string;
  role: string;
  content: string;
  /** Tool-activity + receipt parts (chat-agent.ts's `reconstructUiParts`); null for legacy text-only rows. */
  parts: unknown[] | null;
}

/**
 * Map `chat.history` rows (chronological) to the AI SDK's `UIMessage` shape so
 * `useChat.setMessages` can hydrate a reloaded session with its past tool
 * activity, receipt cards and file chips, not just text.
 *
 * Assistant `parts` already match the AI SDK's own UIMessagePart shapes (see
 * `chat-agent.ts`'s `reconstructUiParts`: text parts + `tool-<name>` parts with
 * `state`/`input`/`output`/`errorText`), so they are reused verbatim.
 *
 * User rows (WP8) persist attachment references as compact `{type:'file',
 * filename, mediaType, attachmentId, v:1}` parts; those are widened here into
 * the AI SDK's `FileUIPart` (which needs a `url`) pointing at the authenticated
 * serve route, so a reload rehydrates the sent-file chips.
 *
 * Legacy rows (parts is `null`, predating the `parts` column) fall back to a
 * single synthetic text part built from `content`. Any unrecognised part shape
 * is passed through untouched (tolerant reader).
 *
 * Pure and framework-free by design (no React/DOM) so it is unit-testable
 * without a browser environment — see history-to-ui-messages.test.ts.
 */
export function historyRowsToUIMessages(rows: readonly ChatHistoryRow[]): UIMessage[] {
  return rows.map((row) => ({
    id: row.id,
    role: row.role === "user" ? "user" : "assistant",
    parts: (row.parts ?? [{ type: "text", text: row.content }]).map(widenPersistedPart) as UIMessage["parts"],
  }));
}

/** Widen a persisted `{type:'file', attachmentId, …}` reference into a `FileUIPart` with a serve-route url; pass everything else through. */
function widenPersistedPart(part: unknown): unknown {
  if (
    part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "file" &&
    typeof (part as { attachmentId?: unknown }).attachmentId === "string"
  ) {
    const p = part as { filename?: unknown; mediaType?: unknown; attachmentId: string };
    return {
      type: "file",
      mediaType: typeof p.mediaType === "string" ? p.mediaType : "application/octet-stream",
      filename: typeof p.filename === "string" ? p.filename : "Attachment",
      url: `/api/chat/attachments/${p.attachmentId}`,
    };
  }
  return part;
}
