import { createDb, getOrCreateChatSession, insertLlmCall, migrateDb, upsertUser, type Db, type DbHandle } from "@pebble/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertCachePrefixIntact } from "../eval/harness";

/**
 * WP10 — unit coverage for the eval-harness cache-prefix tripwire
 * (`assertCachePrefixIntact`), against a plain PGlite db + directly-inserted
 * llm_calls rows. NO model calls, NO streaming — this only exercises the
 * pure "read the last ledgered row for a session" logic that the live eval
 * scenarios (never run here) rely on as their regression guard.
 */

const USER_ID = "eval-tripwire-user";

describe("assertCachePrefixIntact (eval harness cache tripwire)", () => {
  let handle: DbHandle;
  let db: Db;

  beforeAll(async () => {
    handle = await createDb({ pglite: true, pgliteDir: "memory://" });
    await migrateDb(handle);
    db = handle.db as unknown as Db;
    await upsertUser(db, {
      firebaseUid: USER_ID,
      email: "eval-tripwire@greenberg.test",
      displayName: "Eval Tripwire",
      role: "estimator",
      active: true,
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  it("fails (ok:false) when the session has no ledgered calls at all", async () => {
    const sessionId = "trip-none";
    await getOrCreateChatSession(db, { sessionId, userId: USER_ID });
    const result = await assertCachePrefixIntact(db, sessionId);
    expect(result.ok).toBe(false);
    expect(result.cacheReadTokens).toBeNull();
  });

  it("fails when the LAST turn reads zero cache tokens, even if an earlier turn did not", async () => {
    const sessionId = "trip-zero-last";
    await getOrCreateChatSession(db, { sessionId, userId: USER_ID });
    // Turn 1: no cache read yet (cold cache, expected on the first turn).
    await insertLlmCall(db, {
      sessionId,
      lane: "claude",
      model: "claude-sonnet-4-6",
      inputTokens: 500,
      outputTokens: 100,
      costUsd: 0.01,
      cacheReadTokens: 0,
      cacheWriteTokens: 400,
    });
    // Turn 2 (the LAST turn): busted prefix — still zero cache reads.
    await insertLlmCall(db, {
      sessionId,
      lane: "claude",
      model: "claude-sonnet-4-6",
      inputTokens: 500,
      outputTokens: 100,
      costUsd: 0.01,
      cacheReadTokens: 0,
      cacheWriteTokens: 400,
    });

    const result = await assertCachePrefixIntact(db, sessionId);
    expect(result.ok).toBe(false);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.note).toContain("CACHE TRIPWIRE FAILED");
  });

  it("passes when the LAST turn reads a nonzero number of cache tokens", async () => {
    const sessionId = "trip-hit";
    await getOrCreateChatSession(db, { sessionId, userId: USER_ID });
    // Turn 1: cold cache — writes, no reads.
    await insertLlmCall(db, {
      sessionId,
      lane: "claude",
      model: "claude-sonnet-4-6",
      inputTokens: 500,
      outputTokens: 100,
      costUsd: 0.01,
      cacheReadTokens: 0,
      cacheWriteTokens: 400,
    });
    // Turn 2 (the LAST turn): the cached prefix hit, as expected on a healthy 2nd turn.
    await insertLlmCall(db, {
      sessionId,
      lane: "claude",
      model: "claude-sonnet-4-6",
      inputTokens: 50,
      outputTokens: 100,
      costUsd: 0.002,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });

    const result = await assertCachePrefixIntact(db, sessionId);
    expect(result.ok).toBe(true);
    expect(result.cacheReadTokens).toBe(400);
    expect(result.note).toContain("cache prefix intact");
  });

  it("is isolated per session (a different session's rows never leak in)", async () => {
    const sessionA = "trip-iso-a";
    const sessionB = "trip-iso-b";
    await getOrCreateChatSession(db, { sessionId: sessionA, userId: USER_ID });
    await getOrCreateChatSession(db, { sessionId: sessionB, userId: USER_ID });
    await insertLlmCall(db, {
      sessionId: sessionA,
      lane: "claude",
      model: "claude-sonnet-4-6",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      cacheReadTokens: 9999,
      cacheWriteTokens: 0,
    });

    const resultB = await assertCachePrefixIntact(db, sessionB);
    expect(resultB.ok).toBe(false);
    expect(resultB.cacheReadTokens).toBeNull();
  });
});
