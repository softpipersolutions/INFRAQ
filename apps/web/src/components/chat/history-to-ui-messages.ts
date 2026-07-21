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
 * A neutral placeholder the tolerant reader substitutes for a persisted tool
 * part it cannot make sense of (missing `state`/`input`), so a single malformed
 * row renders an "Unavailable step" caption instead of crashing the transcript.
 */
export const UNAVAILABLE_PART = { type: "data-unavailable", v: 1 } as const;

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
 * single synthetic text part built from `content`.
 *
 * WP13 tolerant reader: forward-compatible against schema drift. A part whose
 * `type` this build does not recognise is skipped (`console.debug`); a tool part
 * missing the fields needed to render it (`state`, and any of input/output/
 * errorText) is replaced with a neutral `data-unavailable` placeholder rather
 * than being handed to the renderer half-formed. Known markers (`data-stopped`,
 * `data-unavailable`) pass through untouched.
 *
 * Pure and framework-free by design (no React/DOM) so it is unit-testable
 * without a browser environment — see history-to-ui-messages.test.ts.
 */
export function historyRowsToUIMessages(rows: readonly ChatHistoryRow[]): UIMessage[] {
  return rows.map((row) => ({
    id: row.id,
    role: row.role === "user" ? "user" : "assistant",
    parts: normalizePersistedParts(row.parts, row.content) as UIMessage["parts"],
  }));
}

/** The set of `data-*` marker parts this build renders directly (no widening needed). */
const KNOWN_MARKER_TYPES = new Set(["data-stopped", "data-unavailable"]);

/**
 * Map a row's persisted parts into render-ready parts, dropping the unknown and
 * repairing the malformed. A `null` parts column (legacy text-only row) becomes
 * a single synthetic text part; an explicit empty array stays empty (per the
 * router's `unknown[] | null` contract, `[]` is real content, not a fallback).
 */
function normalizePersistedParts(parts: unknown[] | null, content: string): unknown[] {
  if (parts == null) return [{ type: "text", text: content }];
  const out: unknown[] = [];
  for (const part of parts) {
    const normalized = normalizePersistedPart(part);
    if (normalized !== null) out.push(normalized);
  }
  return out;
}

/**
 * Normalize one persisted part. Returns the render-ready part, or `null` when it
 * should be dropped from the transcript entirely (unknown/garbage shapes).
 */
function normalizePersistedPart(part: unknown): unknown | null {
  if (!part || typeof part !== "object") {
    console.debug("[chat] skipping non-object persisted part", part);
    return null;
  }
  const type = (part as { type?: unknown }).type;
  if (typeof type !== "string") {
    console.debug("[chat] skipping persisted part with no string type", part);
    return null;
  }

  if (type === "text") {
    // A text part must carry a string `text`; anything else is unrenderable.
    if (typeof (part as { text?: unknown }).text !== "string") {
      console.debug("[chat] skipping malformed text part", part);
      return null;
    }
    return part;
  }

  if (type === "file") return widenPersistedPart(part);

  if (KNOWN_MARKER_TYPES.has(type)) return part;

  if (type.startsWith("tool-") || type === "dynamic-tool") {
    const p = part as { state?: unknown; input?: unknown; output?: unknown; errorText?: unknown };
    const hasState = typeof p.state === "string";
    const hasPayload = p.input !== undefined || p.output !== undefined || p.errorText !== undefined;
    if (!hasState || !hasPayload) {
      console.debug("[chat] repairing malformed tool part as data-unavailable", type);
      return { ...UNAVAILABLE_PART };
    }
    return part;
  }

  console.debug("[chat] skipping unknown persisted part type", type);
  return null;
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
