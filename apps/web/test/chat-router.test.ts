import { applyExtracted, initSlotState, type SlotState } from "@pebble/ai";
import {
  createDb,
  getOrCreateChatSession,
  insertLlmCall,
  migrateDb,
  seedDatabase,
  updateSlotState,
  upsertUser,
  type AppUser,
  type Db,
  type DbHandle,
} from "@pebble/db";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDailyBudget } from "../src/server/chat-runtime";
import { appRouter } from "../src/server/routers/_app";
import { createCallerFactory, type Ctx } from "../src/server/trpc";

/**
 * Chat control-plane router tests (createCaller over an in-memory PGlite db,
 * no real model keys). Covers slot-state read/progression, the confirm →
 * real-enquiry + LOCKED v1 path, the budget guard helper and RBAC.
 */

const createCaller = createCallerFactory(appRouter);

const ESTIMATOR: AppUser = {
  firebaseUid: "chat-estimator",
  email: "chat-estimator@greenberg.test",
  displayName: "Chat Estimator",
  role: "estimator",
  active: true,
};

/** A fully-captured (proposed) slot state for the demo enquiry. */
function demoSlotState(): SlotState {
  return applyExtracted(initSlotState(), {
    clientName: "Acme Fire Pvt Ltd",
    projectName: "Acme HQ",
    buildingType: "Commercial",
    floorsAbove: 4,
    floorAreaSqm: 450,
    systemsRequired: ["FAS", "Extinguisher"],
    makePreference: "Standard",
    projectTier: 2,
  });
}

describe("chat router", () => {
  let handle: DbHandle;
  let db: Db;

  beforeAll(async () => {
    handle = await createDb({ pglite: true, pgliteDir: "memory://" });
    await migrateDb(handle);
    await seedDatabase(handle.db);
    db = handle.db as unknown as Db;
    await upsertUser(db, ESTIMATOR); // FK: chat_sessions.user_id → users
  });

  afterAll(async () => {
    await handle.close();
  });

  function callerFor(user: Ctx["user"]) {
    return createCaller({ db, user });
  }

  it("RBAC: unauthenticated caller is UNAUTHORIZED", async () => {
    const caller = callerFor(null);
    let code: string | null = null;
    try {
      await caller.chat.sessionState({ sessionId: "any" });
    } catch (err) {
      if (err instanceof TRPCError) code = err.code;
      else throw err;
    }
    expect(code).toBe("UNAUTHORIZED");
  });

  it("sessionState on a fresh session is empty and not ready to confirm", async () => {
    const caller = callerFor(ESTIMATOR);
    const state = await caller.chat.sessionState({ sessionId: "fresh-session" });
    expect(state.enquiryId).toBeNull();
    expect(state.readyToConfirm).toBe(false);
    expect(state.allConfirmed).toBe(false);
    expect(state.slotState.clientName.status).toBe("missing");
  });

  it("reflects slot progression written directly to the repo", async () => {
    const caller = callerFor(ESTIMATOR);
    const sessionId = "progress-session";
    await getOrCreateChatSession(db, { sessionId, userId: ESTIMATOR.firebaseUid });
    await updateSlotState(db, sessionId, demoSlotState());

    const state = await caller.chat.sessionState({ sessionId });
    // All required fields captured (proposed) → ready to confirm, not yet all-confirmed.
    expect(state.readyToConfirm).toBe(true);
    expect(state.allConfirmed).toBe(false);
    expect(state.slotState.systemsRequired.value).toEqual(["FAS", "Extinguisher"]);
  });

  it("confirmEnquiry creates a real enquiry + LOCKED v1 estimate and links the session", async () => {
    const caller = callerFor(ESTIMATOR);
    const sessionId = "confirm-session";
    await getOrCreateChatSession(db, { sessionId, userId: ESTIMATOR.firebaseUid });
    await updateSlotState(db, sessionId, demoSlotState());

    const { enquiryId, estimateId } = await caller.chat.confirmEnquiry({ sessionId });
    expect(enquiryId).toMatch(/^GBE-ENQ-/);
    expect(estimateId).toMatch(/^GBE-EST-/);

    // LOCKED v1 draft exists.
    const view = await caller.estimate.get({ estimateId });
    expect(view.version.state).toBe("LOCKED");
    expect(view.version.versionNo).toBe(1);
    expect(view.lines.length).toBeGreaterThan(0);
    expect(view.estimate.sitcStatus).not.toBeNull();

    // Session is linked and now fully confirmed.
    const state = await caller.chat.sessionState({ sessionId });
    expect(state.enquiryId).toBe(enquiryId);
    expect(state.allConfirmed).toBe(true);

    // A second confirm on the same session is a CONFLICT (already created).
    let code: string | null = null;
    try {
      await caller.chat.confirmEnquiry({ sessionId });
    } catch (err) {
      if (err instanceof TRPCError) code = err.code;
      else throw err;
    }
    expect(code).toBe("CONFLICT");
  });

  it("confirmEnquiry rejects an incomplete slot state with BAD_REQUEST", async () => {
    const caller = callerFor(ESTIMATOR);
    const sessionId = "incomplete-session";
    await getOrCreateChatSession(db, { sessionId, userId: ESTIMATOR.firebaseUid });
    await updateSlotState(
      db,
      sessionId,
      applyExtracted(initSlotState(), { clientName: "Only a name" }),
    );
    let code: string | null = null;
    try {
      await caller.chat.confirmEnquiry({ sessionId });
    } catch (err) {
      if (err instanceof TRPCError) code = err.code;
      else throw err;
    }
    expect(code).toBe("BAD_REQUEST");
  });

  it("budget guard: spend past the cap blocks; a higher cap does not", async () => {
    const sessionId = "budget-session";
    await getOrCreateChatSession(db, { sessionId, userId: ESTIMATOR.firebaseUid });
    await insertLlmCall(db, {
      sessionId,
      lane: "claude",
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 6.0,
    });

    const blocked = await checkDailyBudget(db, {
      userId: ESTIMATOR.firebaseUid,
      env: { PEBBLE_DAILY_LLM_BUDGET_USD: "5" },
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.spentUsd).toBeGreaterThanOrEqual(6);

    const ok = await checkDailyBudget(db, {
      userId: ESTIMATOR.firebaseUid,
      env: { PEBBLE_DAILY_LLM_BUDGET_USD: "100" },
    });
    expect(ok.blocked).toBe(false);
    expect(ok.remainingUsd).toBeGreaterThan(0);

    // costToday surfaces the same numbers to the UI tile.
    const caller = callerFor(ESTIMATOR);
    const cost = await caller.chat.costToday();
    expect(cost.spentUsd).toBeGreaterThanOrEqual(6);
  });
});
