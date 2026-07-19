import { and, desc, eq, gt, gte, like, sql } from "drizzle-orm";
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
 */

/** The JSON `null` literal for the NOT NULL slot_state column (a fresh session). */
const JSON_NULL = sql`'null'::jsonb`;

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
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export async function getChatSession(db: Db, sessionId: string): Promise<ChatSessionRow | null> {
  const rows = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).limit(1);
  const r = rows[0];
  return r ? rowToSession(r) : null;
}

/**
 * Idempotent get-or-create keyed on the client-supplied session UUID. The
 * insert is a no-op on conflict, so an existing session's slot state / enquiry
 * link / user are never clobbered — the row is always read back and returned.
 */
export async function getOrCreateChatSession(
  db: Db,
  args: { sessionId: string; userId: string },
): Promise<ChatSessionRow> {
  await db
    .insert(chatSessions)
    .values({ id: args.sessionId, userId: args.userId, slotState: JSON_NULL })
    .onConflictDoNothing({ target: chatSessions.id });

  const row = await getChatSession(db, args.sessionId);
  if (!row) throw new Error(`Chat session ${args.sessionId} not found after upsert`);
  return row;
}

/** Overwrite the slot-filling state (pass `null` to clear it back to a fresh session). */
export async function updateSlotState(
  db: Db,
  sessionId: string,
  slotState: unknown,
): Promise<void> {
  await db
    .update(chatSessions)
    .set({
      slotState: (slotState === null ? JSON_NULL : slotState) as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(eq(chatSessions.id, sessionId));
}

/** Link the session to the enquiry it created (chat_sessions.enquiry_id is not an FK — see schema). */
export async function linkSessionEnquiry(
  db: Db,
  sessionId: string,
  enquiryId: string,
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ enquiryId, updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId));
}

/**
 * Overwrite the Gemini-Flash running summary and advance its watermark
 * (`summaryUptoMessageId`). Called by the summary-refresh trigger once more
 * than `PEBBLE_CHAT_WINDOW` unsummarized turns have accumulated.
 */
export async function updateSessionSummary(
  db: Db,
  sessionId: string,
  args: { summary: string; uptoMessageId: string },
): Promise<void> {
  await db
    .update(chatSessions)
    .set({
      summary: args.summary,
      summaryUptoMessageId: args.uptoMessageId,
      updatedAt: new Date(),
    })
    .where(eq(chatSessions.id, sessionId));
}

/** Overwrite the contradiction counter outright (e.g. reset on `reset_enquiry_capture`). */
export async function setContradictions(db: Db, sessionId: string, count: number): Promise<void> {
  await db
    .update(chatSessions)
    .set({ contradictions: count, updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId));
}

/**
 * Atomically bump the contradiction counter and return the new value — the
 * Opus escalation guard reads this to decide `contradictions >= 2`.
 */
export async function incrementContradictions(
  db: Db,
  sessionId: string,
  by = 1,
): Promise<number> {
  const rows = await db
    .update(chatSessions)
    .set({
      contradictions: sql`${chatSessions.contradictions} + ${by}`,
      updatedAt: new Date(),
    })
    .where(eq(chatSessions.id, sessionId))
    .returning({ contradictions: chatSessions.contradictions });
  const row = rows[0];
  if (!row) throw new Error(`Chat session ${sessionId} not found`);
  return row.contradictions;
}

// ─── Messages ────────────────────────────────────────────────────────────────

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
  await db.insert(chatMessages).values({
    id,
    sessionId: args.sessionId,
    role: args.role,
    content: args.content,
    lane: args.lane ?? null,
    model: args.model ?? null,
    parts: args.parts ?? null,
  });
  return id;
}

/**
 * The `limit` most recent messages for a session, returned in chronological
 * (oldest-first) order — the shape a model prompt or a transcript expects.
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
