import { applyExtracted, initSlotState, type SlotState } from "@pebble/ai";
import {
  appendChatMessage,
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

/** A second signed-in user who tries to reach ESTIMATOR's sessions by UUID. */
const OTHER: AppUser = {
  firebaseUid: "chat-other",
  email: "chat-other@greenberg.test",
  displayName: "Chat Other",
  role: "estimator",
  active: true,
};

/** An admin — ownership is strict owner-only, so even an admin cannot reach a foreign session. */
const ADMIN: AppUser = {
  firebaseUid: "chat-admin",
  email: "chat-admin@greenberg.test",
  displayName: "Chat Admin",
  role: "admin",
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
    await upsertUser(db, OTHER);
    await upsertUser(db, ADMIN);
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
    await updateSlotState(db, sessionId, ESTIMATOR.firebaseUid, demoSlotState());

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
    await updateSlotState(db, sessionId, ESTIMATOR.firebaseUid, demoSlotState());

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
      ESTIMATOR.firebaseUid,
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

    // costToday surfaces the same numbers to the UI tile, plus the Opus slice.
    const caller = callerFor(ESTIMATOR);
    const cost = await caller.chat.costToday();
    expect(cost.spentUsd).toBeGreaterThanOrEqual(6);
    expect(cost.opusSpentToday).toBe(0); // the seeded call was a Sonnet call
  });

  it("history returns tool/receipt parts for reload fidelity", async () => {
    const caller = callerFor(ESTIMATOR);
    const sessionId = "parts-history-session";
    await getOrCreateChatSession(db, { sessionId, userId: ESTIMATOR.firebaseUid });
    await appendChatMessage(db, { sessionId, role: "user", content: "8 floor office" });
    await appendChatMessage(db, {
      sessionId,
      role: "assistant",
      content: "Checked the design rules.",
      lane: "claude",
      model: "claude-sonnet-4-6",
      parts: [
        { type: "text", text: "Checked the design rules." },
        { type: "tool-get_design_rules", toolCallId: "t1", state: "output-available", input: {}, output: [] },
      ],
    });

    const history = await caller.chat.history({ sessionId });
    const assistant = history.find((m) => m.role === "assistant");
    expect(assistant?.parts).toBeTruthy();
    const partTypes = (assistant?.parts as Array<{ type: string }>).map((p) => p.type);
    expect(partTypes).toContain("tool-get_design_rules");
    // A legacy text-only user row has null parts.
    const userRow = history.find((m) => m.role === "user");
    expect(userRow?.parts).toBeNull();
  });

  it("session ownership: a non-owner (incl. admin) gets NOT_FOUND on every session procedure; the owner still succeeds", async () => {
    const owner = callerFor(ESTIMATOR);
    const other = callerFor(OTHER);
    const admin = callerFor(ADMIN);

    // ESTIMATOR owns a fully-captured session (ready to confirm, not yet linked) with a message.
    const sessionId = "xuser-session";
    await getOrCreateChatSession(db, { sessionId, userId: ESTIMATOR.firebaseUid });
    await updateSlotState(db, sessionId, ESTIMATOR.firebaseUid, demoSlotState());
    await appendChatMessage(db, { sessionId, role: "user", content: "secret enquiry" });

    const codeOf = async (fn: () => Promise<unknown>): Promise<string | null> => {
      try {
        await fn();
        return null;
      } catch (err) {
        if (err instanceof TRPCError) return err.code;
        throw err;
      }
    };

    // Knowing the UUID is not enough: every read/mutation by a non-owner — an
    // ordinary user AND an admin — is NOT_FOUND (never FORBIDDEN, no existence leak).
    for (const caller of [other, admin]) {
      expect(await codeOf(() => caller.chat.sessionState({ sessionId }))).toBe("NOT_FOUND");
      expect(await codeOf(() => caller.chat.history({ sessionId }))).toBe("NOT_FOUND");
      expect(await codeOf(() => caller.chat.confirmEnquiry({ sessionId }))).toBe("NOT_FOUND");
      expect(await codeOf(() => caller.chat.reset({ sessionId }))).toBe("NOT_FOUND");
    }

    // The owner is unaffected — the foreign confirm/reset attempts were all no-ops.
    const ownerState = await owner.chat.sessionState({ sessionId });
    expect(ownerState.enquiryId).toBeNull();
    expect(ownerState.readyToConfirm).toBe(true);
    expect(ownerState.slotState.clientName.value).toBe("Acme Fire Pvt Ltd");

    const ownerHistory = await owner.chat.history({ sessionId });
    expect(ownerHistory.some((m) => m.content === "secret enquiry")).toBe(true);

    // And the owner can still confirm — proving the state survived the foreign attempts.
    const { enquiryId } = await owner.chat.confirmEnquiry({ sessionId });
    expect(enquiryId).toMatch(/^GBE-ENQ-/);
  });
});
