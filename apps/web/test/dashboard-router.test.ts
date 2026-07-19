import { createDb, migrateDb, newUlid, schema, seedDatabase, type AppUser, type Db, type DbHandle } from "@pebble/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "../src/server/routers/_app";
import { createCallerFactory } from "../src/server/trpc";

/**
 * dashboard.llmCost — sums llm_calls into today/this-month cost + call count
 * for the AI spend tile. Independent of the chat router (a parallel lane
 * owns chat_sessions/chat writes); this test inserts llm_calls rows directly
 * via the schema, mirroring how ingestion-router.test.ts seeds fixtures.
 */

const createCaller = createCallerFactory(appRouter);

function estimator(): AppUser {
  return {
    firebaseUid: "test-estimator",
    email: "estimator@greenberg.test",
    displayName: "Test Estimator",
    role: "estimator",
    active: true,
  };
}

describe("dashboard.llmCost", () => {
  let handle: DbHandle;
  let db: Db;

  beforeAll(async () => {
    handle = await createDb({ pglite: true, pgliteDir: "memory://" });
    await migrateDb(handle);
    await seedDatabase(handle.db);
    db = handle.db as unknown as Db;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("sums today's and this month's llm_calls cost + call count", async () => {
    const caller = createCaller({ db, user: estimator() });

    const before = await caller.dashboard.llmCost();
    expect(before.today.calls).toBe(0);
    expect(before.today.costUsd).toBe(0);

    await db.insert(schema.llmCalls).values([
      {
        id: newUlid(),
        sessionId: null,
        lane: "gemini",
        model: "gemini-3.5-flash",
        intent: "EXTRACT",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: "0.001234",
      },
      {
        id: newUlid(),
        sessionId: null,
        lane: "claude",
        model: "claude-sonnet-5",
        intent: "DRAFT_ASSIST",
        inputTokens: 500,
        outputTokens: 200,
        costUsd: "0.045000",
      },
    ]);

    const after = await caller.dashboard.llmCost();
    expect(after.today.calls).toBe(2);
    expect(after.today.costUsd).toBeCloseTo(0.001234 + 0.045, 6);
    expect(after.month.calls).toBeGreaterThanOrEqual(2);
    expect(after.month.costUsd).toBeGreaterThanOrEqual(after.today.costUsd);
  });

  it("requires sign-in", async () => {
    const caller = createCaller({ db, user: null });
    await expect(caller.dashboard.llmCost()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
