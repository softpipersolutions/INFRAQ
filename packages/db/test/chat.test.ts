import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Db, DbHandle } from "../src/index";
import {
  appendChatMessage,
  ChatSessionOwnershipError,
  countMessagesAfter,
  createDb,
  getChatSession,
  getChatSessionOwner,
  getOrCreateChatSession,
  incrementContradictions,
  insertLlmCall,
  linkSessionEnquiry,
  listChatMessages,
  migrateDb,
  setContradictions,
  sumLlmCostSince,
  sumOpusSpendSince,
  updateSessionSummary,
  updateSlotState,
  upsertUser,
} from "../src/index";
import { chatSessions, llmCalls } from "../src/schema";
import { freshDb } from "./helpers";

const DRIZZLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

let handle: DbHandle;
let db: Db;
beforeEach(async () => {
  handle = await freshDb(); // seeds the dev-admin user + starter masters
  db = handle.db as unknown as Db;
});
afterEach(async () => {
  await handle.close();
});

const DEV_UID = "dev-admin";

describe("0003 chat agent migration", () => {
  it("applies 0003_chat_agent.sql on a fresh database", async () => {
    const fresh = await createDb({ pglite: true, pgliteDir: "memory://" });
    try {
      const applied = await migrateDb(fresh);
      expect(applied).toContain("0003_chat_agent.sql");
    } finally {
      await fresh.close();
    }
  });

  it("adds the summary/watermark/contradictions and parts columns plus the session-id index", async () => {
    const cols = (await db.execute(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'chat_sessions' AND column_name IN ('summary', 'summary_upto_message_id', 'contradictions'))
         OR (table_name = 'chat_messages' AND column_name = 'parts')
      ORDER BY table_name, column_name
    `)) as unknown as { rows: Array<{ table_name: string; column_name: string }> };
    expect(cols.rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      "chat_messages.parts",
      "chat_sessions.contradictions",
      "chat_sessions.summary",
      "chat_sessions.summary_upto_message_id",
    ]);

    const idx = (await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'chat_messages' AND indexname = 'idx_chat_messages_session_id'`,
    )) as unknown as { rows: Array<{ indexname: string }> };
    expect(idx.rows).toHaveLength(1);
  });

  it("re-applies the raw migration SQL without error (multi-clause ADD COLUMN IF NOT EXISTS on PGlite)", async () => {
    const contents = await readFile(join(DRIZZLE_DIR, "0003_chat_agent.sql"), "utf8");
    await expect(handle.exec(contents)).resolves.not.toThrow();
    // Columns are still exactly what they were — a clean no-op, not a duplicate.
    const cols = (await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'chat_sessions' AND column_name = 'contradictions'`,
    )) as unknown as { rows: Array<{ column_name: string }> };
    expect(cols.rows).toHaveLength(1);
  });
});

describe("0004 chat sessions v2 migration", () => {
  it("applies 0004_chat_sessions_v2.sql on a fresh database", async () => {
    const fresh = await createDb({ pglite: true, pgliteDir: "memory://" });
    try {
      const applied = await migrateDb(fresh);
      expect(applied).toContain("0004_chat_sessions_v2.sql");
    } finally {
      await fresh.close();
    }
  });

  it("adds the session-list columns, the cache-token ledger columns and the activity index", async () => {
    const cols = (await db.execute(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'chat_sessions' AND column_name IN
              ('title', 'archived_at', 'pinned_at', 'last_message_at', 'last_message_preview'))
         OR (table_name = 'llm_calls' AND column_name IN ('cache_read_tokens', 'cache_write_tokens'))
      ORDER BY table_name, column_name
    `)) as unknown as { rows: Array<{ table_name: string; column_name: string }> };
    expect(cols.rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      "chat_sessions.archived_at",
      "chat_sessions.last_message_at",
      "chat_sessions.last_message_preview",
      "chat_sessions.pinned_at",
      "chat_sessions.title",
      "llm_calls.cache_read_tokens",
      "llm_calls.cache_write_tokens",
    ]);

    const idx = (await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'chat_sessions' AND indexname = 'idx_chat_sessions_user_activity'`,
    )) as unknown as { rows: Array<{ indexname: string }> };
    expect(idx.rows).toHaveLength(1);
  });

  it("re-applies the raw migration SQL without error (idempotent ADD COLUMN IF NOT EXISTS on PGlite)", async () => {
    const contents = await readFile(join(DRIZZLE_DIR, "0004_chat_sessions_v2.sql"), "utf8");
    await expect(handle.exec(contents)).resolves.not.toThrow();
    const cols = (await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'chat_sessions' AND column_name = 'last_message_at'`,
    )) as unknown as { rows: Array<{ column_name: string }> };
    expect(cols.rows).toHaveLength(1);
  });
});

describe("chat sessions", () => {
  it("get-or-create is idempotent and starts with a null (fresh) slot state", async () => {
    const first = await getOrCreateChatSession(db, { sessionId: "sess-1", userId: DEV_UID });
    expect(first.id).toBe("sess-1");
    expect(first.userId).toBe(DEV_UID);
    expect(first.slotState).toBeNull();
    expect(first.enquiryId).toBeNull();

    // Advance the slot state, then re-create with the same id: must NOT clobber it.
    await updateSlotState(db, "sess-1", DEV_UID, { clientName: { status: "confirmed", value: "Acme" } });
    const second = await getOrCreateChatSession(db, { sessionId: "sess-1", userId: DEV_UID });
    expect(second.slotState).toEqual({ clientName: { status: "confirmed", value: "Acme" } });

    // Exactly one row exists.
    const rows = await db.select().from(chatSessions).where(eq(chatSessions.id, "sess-1"));
    expect(rows).toHaveLength(1);
  });

  it("get-or-create rejects a session UUID that already belongs to a different user", async () => {
    await upsertUser(db, {
      firebaseUid: "owner-a",
      email: "owner-a@greenberg.test",
      displayName: "Owner A",
      role: "estimator",
      active: true,
    });
    await upsertUser(db, {
      firebaseUid: "attacker-b",
      email: "attacker-b@greenberg.test",
      displayName: "Attacker B",
      role: "estimator",
      active: true,
    });

    // A owns the session.
    await getOrCreateChatSession(db, { sessionId: "sess-owned", userId: "owner-a" });
    await updateSlotState(db, "sess-owned", "owner-a", {
      clientName: { status: "confirmed", value: "Acme" },
    });

    // B knows the UUID but is not the owner → get-or-create THROWS (never hands back A's row).
    await expect(
      getOrCreateChatSession(db, { sessionId: "sess-owned", userId: "attacker-b" }),
    ).rejects.toBeInstanceOf(ChatSessionOwnershipError);

    // The ownership-agnostic probe still reports the true owner (used only server-side).
    expect(await getChatSessionOwner(db, "sess-owned")).toBe("owner-a");
    expect(await getChatSessionOwner(db, "sess-nonexistent")).toBeNull();

    // Owner-scoped reads/writes isolate B completely.
    expect(await getChatSession(db, "sess-owned", "attacker-b")).toBeNull();
    expect(await getChatSession(db, "sess-owned", "owner-a")).not.toBeNull();

    // A non-owner mutation is a no-op — A's slot state and counter are untouched.
    await updateSlotState(db, "sess-owned", "attacker-b", null);
    await setContradictions(db, "sess-owned", "attacker-b", 9);
    const stillA = await getChatSession(db, "sess-owned", "owner-a");
    expect(stillA?.slotState).toEqual({ clientName: { status: "confirmed", value: "Acme" } });
    expect(stillA?.contradictions).toBe(0);

    // incrementContradictions as a non-owner matches zero rows → throws (nothing to bump).
    await expect(incrementContradictions(db, "sess-owned", "attacker-b")).rejects.toThrow();

    // Exactly one row exists for the UUID.
    const rows = await db.select().from(chatSessions).where(eq(chatSessions.id, "sess-owned"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("owner-a");
  });

  it("round-trips a slot state and clears it back to null", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-rt", userId: DEV_UID });
    const state = {
      buildingType: { status: "proposed", value: "Commercial" },
      systemsRequired: { status: "confirmed", value: ["FAS", "Extinguisher"] },
      floorsAbove: { status: "confirmed", value: 4 },
    };
    await updateSlotState(db, "sess-rt", DEV_UID, state);
    expect((await getChatSession(db, "sess-rt", DEV_UID))?.slotState).toEqual(state);

    await updateSlotState(db, "sess-rt", DEV_UID, null);
    expect((await getChatSession(db, "sess-rt", DEV_UID))?.slotState).toBeNull();
  });

  it("links the created enquiry back to the session", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-link", userId: DEV_UID });
    await linkSessionEnquiry(db, "sess-link", DEV_UID, "GBE-ENQ-2026-042");
    expect((await getChatSession(db, "sess-link", DEV_UID))?.enquiryId).toBe("GBE-ENQ-2026-042");
  });

  it("starts with a null summary/watermark and a zero contradiction counter", async () => {
    const fresh = await getOrCreateChatSession(db, { sessionId: "sess-fresh-agent", userId: DEV_UID });
    expect(fresh.summary).toBeNull();
    expect(fresh.summaryUptoMessageId).toBeNull();
    expect(fresh.contradictions).toBe(0);
  });

  it("updates the running summary and its watermark, read back through getChatSession", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-sum", userId: DEV_UID });
    const msgId = await appendChatMessage(db, { sessionId: "sess-sum", role: "user", content: "Hi" });

    await updateSessionSummary(db, "sess-sum", DEV_UID, {
      summary: "Client asked about a 4-storey commercial FAS enquiry.",
      uptoMessageId: msgId,
    });

    const row = await getChatSession(db, "sess-sum", DEV_UID);
    expect(row?.summary).toBe("Client asked about a 4-storey commercial FAS enquiry.");
    expect(row?.summaryUptoMessageId).toBe(msgId);
  });

  it("sets the contradiction counter outright", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-contra-set", userId: DEV_UID });
    await setContradictions(db, "sess-contra-set", DEV_UID, 3);
    expect((await getChatSession(db, "sess-contra-set", DEV_UID))?.contradictions).toBe(3);

    await setContradictions(db, "sess-contra-set", DEV_UID, 0);
    expect((await getChatSession(db, "sess-contra-set", DEV_UID))?.contradictions).toBe(0);
  });

  it("increments the contradiction counter and returns the new count", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-contra-inc", userId: DEV_UID });

    expect(await incrementContradictions(db, "sess-contra-inc", DEV_UID)).toBe(1);
    expect(await incrementContradictions(db, "sess-contra-inc", DEV_UID)).toBe(2);
    expect(await incrementContradictions(db, "sess-contra-inc", DEV_UID, 3)).toBe(5);

    expect((await getChatSession(db, "sess-contra-inc", DEV_UID))?.contradictions).toBe(5);
  });
});

describe("chat messages", () => {
  it("appends and lists messages in chronological order", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-msg", userId: DEV_UID });
    await appendChatMessage(db, { sessionId: "sess-msg", role: "user", content: "Hi" });
    await appendChatMessage(db, {
      sessionId: "sess-msg",
      role: "assistant",
      content: "Who is the client?",
      lane: "claude",
      model: "claude-sonnet-4-6",
    });
    await appendChatMessage(db, { sessionId: "sess-msg", role: "user", content: "Acme Ltd" });

    const msgs = await listChatMessages(db, "sess-msg");
    expect(msgs.map((m) => m.content)).toEqual(["Hi", "Who is the client?", "Acme Ltd"]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1]?.lane).toBe("claude");
    expect(msgs[1]?.model).toBe("claude-sonnet-4-6");
  });

  it("honours the recent-N limit while keeping chronological order", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-lim", userId: DEV_UID });
    for (let i = 0; i < 5; i++) {
      await appendChatMessage(db, { sessionId: "sess-lim", role: "user", content: `m${i}` });
    }
    const recent = await listChatMessages(db, "sess-lim", 2);
    expect(recent.map((m) => m.content)).toEqual(["m3", "m4"]);
  });

  it("round-trips tool/receipt parts on append, and legacy no-parts rows list as null", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-parts", userId: DEV_UID });

    // Legacy-shaped call: no `parts` at all.
    await appendChatMessage(db, { sessionId: "sess-parts", role: "user", content: "Hi" });

    const parts = [
      { type: "text", text: "Checked design rules" },
      { type: "tool-call", toolName: "get_design_rules", input: { systemType: "FAS" } },
      { type: "tool-result", toolName: "get_design_rules", output: { ruleCode: "DL-FAS-001" } },
    ];
    await appendChatMessage(db, {
      sessionId: "sess-parts",
      role: "assistant",
      content: "Here is what I found.",
      lane: "agent",
      model: "claude-sonnet-5",
      parts,
    });

    // Explicit null is accepted the same as omitting the field.
    await appendChatMessage(db, { sessionId: "sess-parts", role: "user", content: "Thanks", parts: null });

    const msgs = await listChatMessages(db, "sess-parts");
    expect(msgs.map((m) => m.parts)).toEqual([null, parts, null]);
  });

  it("denormalizes last_message_at/preview onto the parent session on append", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-denorm", userId: DEV_UID });
    // Fresh session: no message yet, so no denormalized pointer.
    expect((await getChatSession(db, "sess-denorm", DEV_UID))?.lastMessageAt).toBeNull();
    expect((await getChatSession(db, "sess-denorm", DEV_UID))?.lastMessagePreview).toBeNull();

    await appendChatMessage(db, { sessionId: "sess-denorm", role: "user", content: "First question" });
    const afterFirst = await getChatSession(db, "sess-denorm", DEV_UID);
    expect(afterFirst?.lastMessageAt).toBeInstanceOf(Date);
    expect(afterFirst?.lastMessagePreview).toBe("First question");
    const firstAt = afterFirst!.lastMessageAt!;

    // A long assistant reply: preview is truncated to the first 120 chars, and
    // the pointer advances to the newest message.
    const long = "A".repeat(200);
    await appendChatMessage(db, { sessionId: "sess-denorm", role: "assistant", content: long, lane: "claude" });
    const afterSecond = await getChatSession(db, "sess-denorm", DEV_UID);
    expect(afterSecond?.lastMessagePreview).toBe("A".repeat(120));
    expect(afterSecond!.lastMessageAt!.getTime()).toBeGreaterThanOrEqual(firstAt.getTime());
  });

  it("scopes the denormalization to the appended session only", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-denorm-a", userId: DEV_UID });
    await getOrCreateChatSession(db, { sessionId: "sess-denorm-b", userId: DEV_UID });
    await appendChatMessage(db, { sessionId: "sess-denorm-a", role: "user", content: "only A" });
    // B was never appended to → its pointer stays null.
    expect((await getChatSession(db, "sess-denorm-b", DEV_UID))?.lastMessagePreview).toBeNull();
    expect((await getChatSession(db, "sess-denorm-a", DEV_UID))?.lastMessagePreview).toBe("only A");
  });

  it("countMessagesAfter counts unsummarized turns with and without a watermark", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-count", userId: DEV_UID });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await appendChatMessage(db, { sessionId: "sess-count", role: "user", content: `m${i}` }));
    }

    // Null watermark = every message in the session.
    expect(await countMessagesAfter(db, "sess-count", null)).toBe(4);
    // After the 2nd message (index 1): the 2 that follow it.
    expect(await countMessagesAfter(db, "sess-count", ids[1] as string)).toBe(2);
    // After the last message: none.
    expect(await countMessagesAfter(db, "sess-count", ids[3] as string)).toBe(0);
    // A session with no messages at all.
    await getOrCreateChatSession(db, { sessionId: "sess-count-empty", userId: DEV_UID });
    expect(await countMessagesAfter(db, "sess-count-empty", null)).toBe(0);
  });
});

describe("llm cost ledger", () => {
  it("sums spend per user and counts session-less calls only in the global tally", async () => {
    // Two users, each with their own session.
    await upsertUser(db, {
      firebaseUid: "user-a",
      email: "a@greenberg.test",
      displayName: "A",
      role: "estimator",
      active: true,
    });
    await upsertUser(db, {
      firebaseUid: "user-b",
      email: "b@greenberg.test",
      displayName: "B",
      role: "estimator",
      active: true,
    });
    await getOrCreateChatSession(db, { sessionId: "sess-a", userId: "user-a" });
    await getOrCreateChatSession(db, { sessionId: "sess-b", userId: "user-b" });

    await insertLlmCall(db, { sessionId: "sess-a", lane: "claude", model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0, costUsd: 0.5 });
    await insertLlmCall(db, { sessionId: "sess-a", lane: "gemini", model: "gemini-3.5-flash", inputTokens: 0, outputTokens: 0, costUsd: 0.25 });
    await insertLlmCall(db, { sessionId: "sess-b", lane: "claude", model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0, costUsd: 1.0 });
    // A session-less call (e.g. ingestion) — attributable to nobody.
    await insertLlmCall(db, { sessionId: null, lane: "gemini", model: "gemini-3.5-flash", inputTokens: 0, outputTokens: 0, costUsd: 4.0 });

    const since = "2000-01-01T00:00:00.000Z";
    expect(await sumLlmCostSince(db, { userId: "user-a", sinceISO: since })).toBeCloseTo(0.75, 6);
    expect(await sumLlmCostSince(db, { userId: "user-b", sinceISO: since })).toBeCloseTo(1.0, 6);
    // Global tally includes the session-less call.
    expect(await sumLlmCostSince(db, { sinceISO: since })).toBeCloseTo(5.75, 6);
  });

  it("round-trips the optional cache read/write token counts, defaulting to null", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-cache", userId: DEV_UID });

    // With cache usage supplied.
    await insertLlmCall(db, {
      sessionId: "sess-cache",
      lane: "claude",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
      cacheReadTokens: 512,
      cacheWriteTokens: 128,
    });
    // Without: legacy shape omits them → columns are null.
    await insertLlmCall(db, {
      sessionId: "sess-cache",
      lane: "gemini",
      model: "gemini-3.5-flash",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    });

    const rows = await db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.sessionId, "sess-cache"))
      .orderBy(llmCalls.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.cacheReadTokens).toBe(512);
    expect(rows[0]?.cacheWriteTokens).toBe(128);
    expect(rows[1]?.cacheReadTokens).toBeNull();
    expect(rows[1]?.cacheWriteTokens).toBeNull();
  });

  it("excludes calls before the since instant", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-t", userId: DEV_UID });
    await insertLlmCall(db, { sessionId: "sess-t", lane: "claude", model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0, costUsd: 2.0 });
    // A future window contains nothing.
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await sumLlmCostSince(db, { userId: DEV_UID, sinceISO: future })).toBe(0);
  });
});

describe("opus escalation spend guard", () => {
  it("sums cost and turn count for claude-opus* models only, scoped to the user", async () => {
    await upsertUser(db, {
      firebaseUid: "user-opus-a",
      email: "opus-a@greenberg.test",
      displayName: "Opus A",
      role: "estimator",
      active: true,
    });
    await upsertUser(db, {
      firebaseUid: "user-opus-b",
      email: "opus-b@greenberg.test",
      displayName: "Opus B",
      role: "estimator",
      active: true,
    });
    await getOrCreateChatSession(db, { sessionId: "sess-opus-a", userId: "user-opus-a" });
    await getOrCreateChatSession(db, { sessionId: "sess-opus-b", userId: "user-opus-b" });

    // Two Opus turns for user A ...
    await insertLlmCall(db, { sessionId: "sess-opus-a", lane: "agent-opus", model: "claude-opus-4-8", intent: "agent-opus:challenge", inputTokens: 0, outputTokens: 0, costUsd: 0.15 });
    await insertLlmCall(db, { sessionId: "sess-opus-a", lane: "agent-opus", model: "claude-opus-4-8", intent: "agent-opus:contradiction", inputTokens: 0, outputTokens: 0, costUsd: 0.2 });
    // ... a Sonnet turn for user A that must NOT count as Opus spend ...
    await insertLlmCall(db, { sessionId: "sess-opus-a", lane: "agent", model: "claude-sonnet-5", inputTokens: 0, outputTokens: 0, costUsd: 0.02 });
    // ... and an Opus turn for a different user that must not leak into A's total.
    await insertLlmCall(db, { sessionId: "sess-opus-b", lane: "agent-opus", model: "claude-opus-4-8", inputTokens: 0, outputTokens: 0, costUsd: 0.37 });

    const since = "2000-01-01T00:00:00.000Z";
    const a = await sumOpusSpendSince(db, { userId: "user-opus-a", sinceISO: since });
    expect(a.turns).toBe(2);
    expect(a.costUsd).toBeCloseTo(0.35, 6);

    const b = await sumOpusSpendSince(db, { userId: "user-opus-b", sinceISO: since });
    expect(b.turns).toBe(1);
    expect(b.costUsd).toBeCloseTo(0.37, 6);
  });

  it("excludes Opus calls before the since instant", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-opus-t", userId: DEV_UID });
    await insertLlmCall(db, { sessionId: "sess-opus-t", lane: "agent-opus", model: "claude-opus-4-8", inputTokens: 0, outputTokens: 0, costUsd: 0.5 });
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = await sumOpusSpendSince(db, { userId: DEV_UID, sinceISO: future });
    expect(result).toEqual({ costUsd: 0, turns: 0 });
  });
});
