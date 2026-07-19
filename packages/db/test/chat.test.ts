import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db, DbHandle } from "../src/index";
import {
  appendChatMessage,
  getChatSession,
  getOrCreateChatSession,
  insertLlmCall,
  linkSessionEnquiry,
  listChatMessages,
  sumLlmCostSince,
  updateSlotState,
  upsertUser,
} from "../src/index";
import { chatSessions } from "../src/schema";
import { freshDb } from "./helpers";

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

describe("chat sessions", () => {
  it("get-or-create is idempotent and starts with a null (fresh) slot state", async () => {
    const first = await getOrCreateChatSession(db, { sessionId: "sess-1", userId: DEV_UID });
    expect(first.id).toBe("sess-1");
    expect(first.userId).toBe(DEV_UID);
    expect(first.slotState).toBeNull();
    expect(first.enquiryId).toBeNull();

    // Advance the slot state, then re-create with the same id: must NOT clobber it.
    await updateSlotState(db, "sess-1", { clientName: { status: "confirmed", value: "Acme" } });
    const second = await getOrCreateChatSession(db, { sessionId: "sess-1", userId: DEV_UID });
    expect(second.slotState).toEqual({ clientName: { status: "confirmed", value: "Acme" } });

    // Exactly one row exists.
    const rows = await db.select().from(chatSessions).where(eq(chatSessions.id, "sess-1"));
    expect(rows).toHaveLength(1);
  });

  it("round-trips a slot state and clears it back to null", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-rt", userId: DEV_UID });
    const state = {
      buildingType: { status: "proposed", value: "Commercial" },
      systemsRequired: { status: "confirmed", value: ["FAS", "Extinguisher"] },
      floorsAbove: { status: "confirmed", value: 4 },
    };
    await updateSlotState(db, "sess-rt", state);
    expect((await getChatSession(db, "sess-rt"))?.slotState).toEqual(state);

    await updateSlotState(db, "sess-rt", null);
    expect((await getChatSession(db, "sess-rt"))?.slotState).toBeNull();
  });

  it("links the created enquiry back to the session", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-link", userId: DEV_UID });
    await linkSessionEnquiry(db, "sess-link", "GBE-ENQ-2026-042");
    expect((await getChatSession(db, "sess-link"))?.enquiryId).toBe("GBE-ENQ-2026-042");
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

  it("excludes calls before the since instant", async () => {
    await getOrCreateChatSession(db, { sessionId: "sess-t", userId: DEV_UID });
    await insertLlmCall(db, { sessionId: "sess-t", lane: "claude", model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0, costUsd: 2.0 });
    // A future window contains nothing.
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await sumLlmCostSince(db, { userId: DEV_UID, sinceISO: future })).toBe(0);
  });
});
