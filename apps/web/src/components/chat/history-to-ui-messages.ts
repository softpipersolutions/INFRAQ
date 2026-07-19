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
 * activity and receipt cards, not just text.
 *
 * Persisted `parts` already match the AI SDK's own UIMessagePart shapes (see
 * `chat-agent.ts`'s `reconstructUiParts`: text parts + `tool-<name>` parts with
 * `state`/`input`/`output`/`errorText`), so they are reused verbatim — only
 * legacy rows (parts is `null`, predating the `parts` column) fall back to a
 * single synthetic text part built from `content`.
 *
 * Pure and framework-free by design (no React/DOM) so it is unit-testable
 * without a browser environment — see history-to-ui-messages.test.ts.
 */
export function historyRowsToUIMessages(rows: readonly ChatHistoryRow[]): UIMessage[] {
  return rows.map((row) => ({
    id: row.id,
    role: row.role === "user" ? "user" : "assistant",
    parts: (row.parts ?? [{ type: "text", text: row.content }]) as UIMessage["parts"],
  }));
}
