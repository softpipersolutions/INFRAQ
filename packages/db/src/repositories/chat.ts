import { and, desc, eq, gt, gte, isNotNull, isNull, like, sql } from "drizzle-orm";
import type { Db } from "../client";
import { newUlid } from "../ids";
import { chatMessages, chatSessions, llmCalls } from "../schema";

/**
 * Conversational enquiry-capture repository (chat lane) + LLM cost accounting.
 *
 * House style: every function takes `db` first so it composes inside a
 * `db.transaction`; ids are monotonic ULIDs (chronological). The chat_session
 * id is NOT generated here — the client supplies a stable UUID (so a refresh
 * resumes the same conversation) which becomes the text primary key.
 *
 * chat_sessions.slot_state is NOT NULL, so a brand-new session stores the JSON
 * `null` literal rather than an empty object; the web layer reads that back as
 * `null` and seeds `initSlotState()`. This package never imports `@pebble/ai`,
 * so the slot-state shape is opaque here (`Record<string, unknown> | null`).
 *
 * SESSION OWNERSHIP (security): every session-row read/mutation keyed by
 * `sessionId` also filters on `user_id`, so knowing another user's session UUID
 * is not enough to read, confirm or reset it. The row-scoped functions take a
 * `userId` and AND it into the predicate; a non-owner simply matches zero rows
 * (a read returns `null`, a mutation is a no-op). `getOrCreateChatSession`
 * additionally THROWS `ChatSessionOwnershipError` when the existing row belongs
 * to a different user, rather than handing back a foreign row. The message
 * helpers (`listChatMessages`, `countMessagesAfter`) and `appendChatMessage`
 * are keyed by `session_id` only and are INTERNAL: callers must first resolve
 * an owned session (via `getChatSession`/`getOrCreateChatSession` with the
 * `userId`) — see each function's doc comment.
 */

/** The JSON `null` literal for the NOT NULL slot_state column (a fresh session). */
const JSON_NULL = sql`'null'::jsonb`;

/**
 * Thrown by `getOrCreateChatSession` when the session UUID already belongs to a
 * DIFFERENT user. The web layer maps this to a `NOT_FOUND` (never `FORBIDDEN`)
 * so it does not leak that the session exists.
 */
export class ChatSessionOwnershipError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Chat session ${sessionId} is owned by a different user`);
    this.name = "ChatSessionOwnershipError";
    this.sessionId = sessionId;
  }
}

export interface ChatSessionRow {
  id: string;
  userId: string;
  slotState: Record<string, unknown> | null;
  enquiryId: string | null;
  /** Gemini-Flash running summary of turns older than the compaction window (null = none yet). */
  summary: string | null;
  /** ULID watermark: `summary` covers messages with id <= this. */
  summaryUptoMessageId: string | null;
  /** Confirmed-slot contradiction counter feeding the Opus escalation guard. */
  contradictions: number;
  /** User/agent-set session label; null on legacy rows (list renders a fallback). */
  title: string | null;
  /** Soft-archive flag: null = active, timestamp = archived. */
  archivedAt: Date | null;
  /** Pin flag: null = unpinned, timestamp = pinned. */
  pinnedAt: Date | null;
  /** Denormalized newest-message time — the session list's sort key. */
  lastMessageAt: Date | null;
  /** First 120 chars of the newest message — the session list preview. */
  lastMessagePreview: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessageRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  lane: string | null;
  model: string | null;
  /** Tool-call/tool-result/receipt parts; null for legacy text-only rows. */
  parts: unknown[] | null;
  createdAt: Date;
}

function rowToSession(r: typeof chatSessions.$inferSelect): ChatSessionRow {
  return {
    id: r.id,
    userId: r.userId,
    slotState: (r.slotState ?? null) as Record<string, unknown> | null,
    enquiryId: r.enquiryId ?? null,
    summary: r.summary ?? null,
    summaryUptoMessageId: r.summaryUptoMessageId ?? null,
    contradictions: r.contradictions,
    title: r.title ?? null,
    archivedAt: r.archivedAt ?? null,
    pinnedAt: r.pinnedAt ?? null,
    lastMessageAt: r.lastMessageAt ?? null,
    lastMessagePreview: r.lastMessagePreview ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/**
 * The session row for `sessionId` — but ONLY if it belongs to `userId`. A
 * non-owner (or a missing row) reads back as `null`, so the caller cannot tell
 * a foreign session apart from one that does not exist.
 */
export async function getChatSession(
  db: Db,
  sessionId: string,
  userId: string,
): Promise<ChatSessionRow | null> {
  const rows = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .limit(1);
  const r = rows[0];
  return r ? rowToSession(r) : null;
}

/**
 * The owning user's id for a session UUID, or `null` when no such row exists —
 * ownership-agnostic. Lets a read-only caller (e.g. the `sessionState` query)
 * distinguish a brand-new session (nothing to hide — show a fresh state) from
 * one that belongs to a DIFFERENT user (surface NOT_FOUND) without a write and
 * without leaking the row's contents.
 */
export async function getChatSessionOwner(db: Db, sessionId: string): Promise<string | null> {
  const rows = await db
    .select({ userId: chatSessions.userId })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  return rows[0]?.userId ?? null;
}

/**
 * Idempotent get-or-create keyed on the client-supplied session UUID. The
 * insert is a no-op on conflict, so an existing session's slot state / enquiry
 * link / user are never clobbered — the row is always read back and returned.
 *
 * Ownership: on conflict the existing row is read back UNFILTERED so a row that
 * already belongs to a DIFFERENT user is rejected with `ChatSessionOwnershipError`
 * instead of being handed to the caller. A same-owner row returns normally, and
 * a brand-new UUID is created for `userId`.
 */
export async function getOrCreateChatSession(
  db: Db,
  args: { sessionId: string; userId: string },
): Promise<ChatSessionRow> {
  await db
    .insert(chatSessions)
    .values({ id: args.sessionId, userId: args.userId, slotState: JSON_NULL })
    .onConflictDoNothing({ target: chatSessions.id });

  // Read back WITHOUT the owner filter: a pre-existing row owned by someone else
  // must be detected (and rejected), not silently returned as if it were ours.
  const rows = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, args.sessionId))
    .limit(1);
  const r = rows[0];
  if (!r) throw new Error(`Chat session ${args.sessionId} not found after upsert`);
  if (r.userId !== args.userId) throw new ChatSessionOwnershipError(args.sessionId);
  return rowToSession(r);
}

/**
 * Overwrite the slot-filling state (pass `null` to clear it back to a fresh
 * session). Owner-scoped: a non-owner matches zero rows and writes nothing.
 */
export async function updateSlotState(
  db: Db,
  sessionId: string,
  userId: string,
  slotState: unknown,
): Promise<void> {
  await db
    .update(chatSessions)
    .set({
      slotState: (slotState === null ? JSON_NULL : slotState) as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)));
}

/**
 * Link the session to the enquiry it created (chat_sessions.enquiry_id is not an
 * FK — see schema). Owner-scoped: a non-owner matches zero rows and writes nothing.
 */
export async function linkSessionEnquiry(
  db: Db,
  sessionId: string,
  userId: string,
  enquiryId: string,
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ enquiryId, updatedAt: new Date() })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)));
}

/**
 * Overwrite the Gemini-Flash running summary and advance its watermark
 * (`summaryUptoMessageId`). Called by the summary-refresh trigger once more
 * than `PEBBLE_CHAT_WINDOW` unsummarized turns have accumulated. Owner-scoped:
 * a non-owner matches zero rows and writes nothing.
 */
export async function updateSessionSummary(
  db: Db,
  sessionId: string,
  userId: string,
  args: { summary: string; uptoMessageId: string },
): Promise<void> {
  await db
    .update(chatSessions)
    .set({
      summary: args.summary,
      summaryUptoMessageId: args.uptoMessageId,
      updatedAt: new Date(),
    })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)));
}

/**
 * Overwrite the contradiction counter outright (e.g. reset on
 * `reset_enquiry_capture`). Owner-scoped: a non-owner matches zero rows and
 * writes nothing.
 */
export async function setContradictions(
  db: Db,
  sessionId: string,
  userId: string,
  count: number,
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ contradictions: count, updatedAt: new Date() })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)));
}

/**
 * Atomically bump the contradiction counter and return the new value — the
 * Opus escalation guard reads this to decide `contradictions >= 2`. Owner-scoped:
 * a non-owner matches zero rows and throws (there is no owned session to bump).
 */
export async function incrementContradictions(
  db: Db,
  sessionId: string,
  userId: string,
  by = 1,
): Promise<number> {
  const rows = await db
    .update(chatSessions)
    .set({
      contradictions: sql`${chatSessions.contradictions} + ${by}`,
      updatedAt: new Date(),
    })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .returning({ contradictions: chatSessions.contradictions });
  const row = rows[0];
  if (!row) throw new Error(`Chat session ${sessionId} not found`);
  return row.contradictions;
}

// ─── Session list (Chat overhaul WP2) ───────────────────────────────────────

/** One row of the owner's session list — the sidebar's read shape. */
export interface ChatSessionListItem {
  id: string;
  /** Raw user/agent-set label; null if never titled (`effectiveTitle` covers the fallback). */
  title: string | null;
  /** `title`, else the first 60 chars of `lastMessagePreview`, else "New chat" — always renderable. */
  effectiveTitle: string;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  pinnedAt: Date | null;
  archivedAt: Date | null;
  enquiryId: string | null;
  createdAt: Date;
}

function effectiveTitleOf(title: string | null, lastMessagePreview: string | null): string {
  if (title && title.trim().length > 0) return title;
  if (lastMessagePreview && lastMessagePreview.trim().length > 0) return lastMessagePreview.slice(0, 60);
  return "New chat";
}

/**
 * The signed-in user's session list, newest-active-first: pinned sessions
 * float to the top (`pinned_at DESC NULLS LAST`), then by most recent activity
 * (`last_message_at DESC NULLS LAST`). Archived sessions are excluded unless
 * `includeArchived` is set (which then mixes active + archived, still ordered
 * the same way — the caller splits by `archivedAt` if it wants two sections).
 *
 * ALWAYS excludes sessions with no `last_message_at`: a session row is created
 * (`getOrCreateChatSession`) before the first message is appended, so a user
 * who opens a fresh chat and never sends anything (or repeatedly hits "start
 * over") leaves behind zero-message orphan rows that would otherwise clutter
 * the list forever. `last_message_at` is only ever set by `appendChatMessage`,
 * so this filter is exactly "has at least one message" without a join. Owner-
 * scoped: only ever returns `userId`'s own sessions.
 */
export async function listChatSessions(
  db: Db,
  args: { userId: string; includeArchived?: boolean; limit?: number },
): Promise<ChatSessionListItem[]> {
  const { userId, includeArchived = false, limit = 100 } = args;
  const predicate = includeArchived
    ? and(eq(chatSessions.userId, userId), isNotNull(chatSessions.lastMessageAt))
    : and(
        eq(chatSessions.userId, userId),
        isNull(chatSessions.archivedAt),
        isNotNull(chatSessions.lastMessageAt),
      );

  const rows = await db
    .select()
    .from(chatSessions)
    .where(predicate)
    .orderBy(
      sql`${chatSessions.pinnedAt} DESC NULLS LAST`,
      sql`${chatSessions.lastMessageAt} DESC NULLS LAST`,
    )
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? null,
    effectiveTitle: effectiveTitleOf(r.title ?? null, r.lastMessagePreview ?? null),
    lastMessageAt: r.lastMessageAt ?? null,
    lastMessagePreview: r.lastMessagePreview ?? null,
    pinnedAt: r.pinnedAt ?? null,
    archivedAt: r.archivedAt ?? null,
    enquiryId: r.enquiryId ?? null,
    createdAt: r.createdAt,
  }));
}

/**
 * Rename a session. Owner-scoped: a non-owner (or missing row) matches zero
 * rows and is a no-op. Trimming and the 1..80 char length are enforced by the
 * router's zod schema (consistent with WP0 style — repos take already-valid
 * input; routers own user-input validation), so this writes `title` verbatim.
 */
export async function renameChatSession(
  db: Db,
  args: { sessionId: string; userId: string; title: string },
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ title: args.title, updatedAt: new Date() })
    .where(and(eq(chatSessions.id, args.sessionId), eq(chatSessions.userId, args.userId)));
}

/**
 * Soft-archive/unarchive a session (sets or clears `archived_at`). Owner-
 * scoped: a non-owner (or missing row) matches zero rows and is a no-op.
 */
export async function setSessionArchived(
  db: Db,
  args: { sessionId: string; userId: string; archived: boolean },
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ archivedAt: args.archived ? new Date() : null, updatedAt: new Date() })
    .where(and(eq(chatSessions.id, args.sessionId), eq(chatSessions.userId, args.userId)));
}

/**
 * Pin/unpin a session (sets or clears `pinned_at`). Owner-scoped: a non-owner
 * (or missing row) matches zero rows and is a no-op.
 */
export async function setSessionPinned(
  db: Db,
  args: { sessionId: string; userId: string; pinned: boolean },
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ pinnedAt: args.pinned ? new Date() : null, updatedAt: new Date() })
    .where(and(eq(chatSessions.id, args.sessionId), eq(chatSessions.userId, args.userId)));
}

/**
 * Internal auto-title setter for the `onFinish` hook (chat-agent.ts): sets
 * `title` ONLY when it is currently NULL, so a fire-and-forget auto-title call
 * — which may resolve well after the turn, racing a user rename — can never
 * clobber a user-chosen title. The `title IS NULL` guard lives in the SQL
 * predicate itself (not a check-then-set from the caller), so it is race-safe
 * even against a concurrent rename. Owner-scoped like every other write here.
 */
export async function setSessionTitle(
  db: Db,
  args: { sessionId: string; userId: string; title: string },
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ title: args.title, updatedAt: new Date() })
    .where(
      and(
        eq(chatSessions.id, args.sessionId),
        eq(chatSessions.userId, args.userId),
        isNull(chatSessions.title),
      ),
    );
}

// ─── Messages ────────────────────────────────────────────────────────────────
//
// Messages are keyed by `session_id` only. These three helpers are INTERNAL and
// server-only: a caller must have already established ownership of `sessionId`
// (via `getChatSession`/`getOrCreateChatSession` with the acting `userId`)
// before appending, listing or counting messages. They never take a `userId`
// because they are only reached after that ownership check on the turn/router
// path — do not expose them to a client without an upstream owner check.

/** INTERNAL/server-only — call only after the session's ownership is established (see above). */
export async function appendChatMessage(
  db: Db,
  args: {
    sessionId: string;
    role: string;
    content: string;
    lane?: string | null;
    model?: string | null;
    parts?: unknown[] | null;
  },
): Promise<string> {
  const id = newUlid();
  const now = new Date();
  await db.insert(chatMessages).values({
    id,
    sessionId: args.sessionId,
    role: args.role,
    content: args.content,
    lane: args.lane ?? null,
    model: args.model ?? null,
    parts: args.parts ?? null,
    createdAt: now,
  });
  // Denormalize the newest-message pointer onto the parent session so the
  // session list (next WP) sorts + previews without scanning chat_messages.
  // INTERNAL invariant: keyed by session_id only (no owner predicate), exactly
  // like the insert above — the caller must have already resolved an owned
  // session (see the block comment for the message helpers). last_message_at
  // is the message's own created time so the two never drift.
  await db
    .update(chatSessions)
    .set({ lastMessageAt: now, lastMessagePreview: args.content.slice(0, 120) })
    .where(eq(chatSessions.id, args.sessionId));
  return id;
}

/**
 * The `limit` most recent messages for a session, returned in chronological
 * (oldest-first) order — the shape a model prompt or a transcript expects.
 *
 * INTERNAL/server-only — keyed by `session_id`, no ownership predicate. The
 * caller MUST have resolved an owned session first (router `history` throws
 * NOT_FOUND on a non-owned session before reaching here; the turn path calls
 * `getOrCreateChatSession` with the user up front).
 */
export async function listChatMessages(
  db: Db,
  sessionId: string,
  limit = 100,
): Promise<ChatMessageRow[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(desc(chatMessages.id))
    .limit(limit);
  return rows
    .map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      role: r.role,
      content: r.content,
      lane: r.lane ?? null,
      model: r.model ?? null,
      parts: (r.parts ?? null) as unknown[] | null,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Count messages newer than `afterMessageId` in a session — ULIDs sort
 * chronologically, so this is a plain `id > watermark` count. `null` counts
 * every message in the session. Feeds the summary-refresh trigger
 * (`> PEBBLE_CHAT_WINDOW` unsummarized turns).
 *
 * INTERNAL/server-only — keyed by `session_id`, no ownership predicate; only
 * reached on the turn path after `getOrCreateChatSession` established ownership.
 */
export async function countMessagesAfter(
  db: Db,
  sessionId: string,
  afterMessageId: string | null,
): Promise<number> {
  const where =
    afterMessageId === null
      ? eq(chatMessages.sessionId, sessionId)
      : and(eq(chatMessages.sessionId, sessionId), gt(chatMessages.id, afterMessageId));
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chatMessages)
    .where(where);
  return rows[0]?.count ?? 0;
}

// ─── LLM cost ledger ─────────────────────────────────────────────────────────

/** One row for the llm_calls cost/latency ledger — matches `toLlmCallLog`'s shape. */
export interface InsertLlmCallArgs {
  sessionId?: string | null;
  lane: string;
  model: string;
  intent?: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Anthropic prompt-cache reads (reporting-only; already folded into costUsd). */
  cacheReadTokens?: number | null;
  /** Anthropic prompt-cache writes (reporting-only; already folded into costUsd). */
  cacheWriteTokens?: number | null;
}

export async function insertLlmCall(db: Db, log: InsertLlmCallArgs): Promise<string> {
  const id = newUlid();
  await db.insert(llmCalls).values({
    id,
    sessionId: log.sessionId ?? null,
    lane: log.lane,
    model: log.model,
    intent: log.intent ?? null,
    inputTokens: log.inputTokens,
    outputTokens: log.outputTokens,
    costUsd: String(log.costUsd), // NUMERIC(10,6) is bound as a string
    cacheReadTokens: log.cacheReadTokens ?? null,
    cacheWriteTokens: log.cacheWriteTokens ?? null,
  });
  return id;
}

/**
 * Total estimated LLM spend (USD) since an instant, for the daily budget guard.
 *
 * With `userId` set, the sum joins llm_calls → chat_sessions on session id and
 * filters to that user — session-less calls (e.g. an ingestion run) cannot be
 * attributed to a user and are excluded. With `userId` omitted, EVERY call
 * since the instant is summed (session-less included) for a global tally.
 */
export async function sumLlmCostSince(
  db: Db,
  args: { userId?: string; sinceISO: string },
): Promise<number> {
  const since = new Date(args.sinceISO);

  if (args.userId) {
    const rows = await db
      .select({ cost: llmCalls.costUsd })
      .from(llmCalls)
      .innerJoin(chatSessions, eq(llmCalls.sessionId, chatSessions.id))
      .where(and(eq(chatSessions.userId, args.userId), gte(llmCalls.createdAt, since)));
    return rows.reduce((sum, r) => sum + Number(r.cost ?? 0), 0);
  }

  const rows = await db
    .select({ cost: llmCalls.costUsd })
    .from(llmCalls)
    .where(gte(llmCalls.createdAt, since));
  return rows.reduce((sum, r) => sum + Number(r.cost ?? 0), 0);
}

/**
 * Opus spend + turn count for a user since an instant — the escalation
 * rate-guard input (`PEBBLE_OPUS_DAILY_CAP_USD` and a max-escalated-turns/day
 * limit). Joins llm_calls → chat_sessions (same session-attribution rule as
 * `sumLlmCostSince`) and filters to models matching `claude-opus%`.
 */
export async function sumOpusSpendSince(
  db: Db,
  args: { userId: string; sinceISO: string },
): Promise<{ costUsd: number; turns: number }> {
  const since = new Date(args.sinceISO);
  const rows = await db
    .select({ cost: llmCalls.costUsd })
    .from(llmCalls)
    .innerJoin(chatSessions, eq(llmCalls.sessionId, chatSessions.id))
    .where(
      and(
        eq(chatSessions.userId, args.userId),
        gte(llmCalls.createdAt, since),
        like(llmCalls.model, "claude-opus%"),
      ),
    );
  return {
    costUsd: rows.reduce((sum, r) => sum + Number(r.cost ?? 0), 0),
    turns: rows.length,
  };
}
