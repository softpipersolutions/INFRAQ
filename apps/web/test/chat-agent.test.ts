import { applyExtracted, initSlotState, type ChatModels, type SlotState } from "@pebble/ai";
import {
  appendChatMessage,
  createDb,
  getChatSession,
  getOrCreateChatSession,
  getVersionWithLines,
  insertLlmCall,
  linkSessionEnquiry,
  listChatMessages,
  migrateDb,
  renameChatSession,
  schema,
  seedDatabase,
  updateSlotState,
  upsertUser,
  type AppUser,
  type Db,
  type DbHandle,
} from "@pebble/db";
import type { LanguageModel } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAiServices } from "../src/server/ai-services";
import { maybeGenerateTitle, maybeRefreshSummary, runAgentTurn } from "../src/server/chat-agent";

/**
 * Agent-turn plumbing over an in-memory PGlite db with scripted stub models (no
 * real keys). Covers the create-from-state guard, self-heal round-trips,
 * contradiction counting, summary-watermark advance, escalation model selection
 * + budget suppression, assistant-parts persistence, and the budget/503 guards.
 */

const USER: AppUser = {
  firebaseUid: "agent-estimator",
  email: "agent@greenberg.test",
  displayName: "Agent Estimator",
  role: "estimator",
  active: true,
};

function fullSlotState(): SlotState {
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

// ─── Stub models ─────────────────────────────────────────────────────────────

/** Minimal array → ReadableStream (avoids `ai/test`, which pulls in an uninstalled `msw`). */
function arrayToStream<T>(items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}

type ScriptTurn = { text: string } | { toolCall: { toolName: string; input: unknown } };

/**
 * A streaming LanguageModel stub: one scripted turn per `doStream` (= per agent
 * step). `cache` (optional) makes each step report Anthropic prompt-cache usage
 * — `read` on the shared usage object (surfaces as `totalUsage.cachedInputTokens`)
 * and `write` via provider metadata (`cache_creation_input_tokens`), so the
 * ledger's cache-token columns can be exercised.
 */
function streamStub(
  modelId: string,
  script: ScriptTurn[],
  cache?: { read?: number; write?: number },
) {
  const invoked = { count: 0 };
  let step = 0;
  const usage = {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    ...(cache?.read ? { cachedInputTokens: cache.read } : {}),
  };
  const finish = (finishReason: string): Record<string, unknown> => ({
    type: "finish",
    finishReason,
    usage,
    ...(cache?.write
      ? { providerMetadata: { anthropic: { usage: { cache_creation_input_tokens: cache.write } } } }
      : {}),
  });
  const model = {
    specificationVersion: "v2",
    provider: "test",
    modelId,
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("doGenerate not used in the streaming agent");
    },
    doStream: async () => {
      invoked.count += 1;
      const turn = script[Math.min(step, script.length - 1)]!;
      step += 1;
      const chunks: Array<Record<string, unknown>> = [{ type: "stream-start", warnings: [] }];
      if ("toolCall" in turn) {
        chunks.push({
          type: "tool-call",
          toolCallId: `call-${step}`,
          toolName: turn.toolCall.toolName,
          input: JSON.stringify(turn.toolCall.input),
        });
        chunks.push(finish("tool-calls"));
      } else {
        const id = `txt-${step}`;
        chunks.push({ type: "text-start", id });
        chunks.push({ type: "text-delta", id, delta: turn.text });
        chunks.push({ type: "text-end", id });
        chunks.push(finish("stop"));
      }
      return { stream: arrayToStream(chunks) };
    },
  } as unknown as LanguageModel;
  return { model, invoked };
}

/** A generateText stub (Gemini summary lane): returns fixed text + usage. */
function generateStub(text: string) {
  const model = {
    specificationVersion: "v2",
    provider: "test",
    modelId: "gemini-stub",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: "stop",
      usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("doStream not used in the summary lane");
    },
  } as unknown as LanguageModel;
  return model;
}

function models(over: Partial<ChatModels> = {}): ChatModels {
  return { classifier: null, claudeDefault: null, claudeOpus: null, ...over };
}

async function drainBody(res: Response): Promise<void> {
  await res.text();
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, tries = 100): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("agent turn + services", () => {
  let handle: DbHandle;
  let db: Db;

  beforeAll(async () => {
    handle = await createDb({ pglite: true, pgliteDir: "memory://" });
    await migrateDb(handle);
    await seedDatabase(handle.db);
    db = handle.db as unknown as Db;
    await upsertUser(db, USER);
  });

  afterAll(async () => {
    await handle.close();
  });

  const actor = { firebaseUid: USER.firebaseUid, role: USER.role };

  function servicesFor(sessionId: string) {
    return createAiServices({ db, actor: USER.firebaseUid, actorRole: USER.role, sessionId });
  }

  // ── create-from-state guard ─────────────────────────────────────────────────

  it("createEnquiryFromState: happy path creates a real enquiry + LOCKED v1 estimate", async () => {
    const sessionId = "svc-create-ok";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    await updateSlotState(db, sessionId, USER.firebaseUid, fullSlotState());

    const result = await servicesFor(sessionId).createEnquiryFromState(sessionId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.enquiryId).toMatch(/^GBE-ENQ-/);
    expect(result.estimateId).toMatch(/^GBE-EST-/);

    const view = await getVersionWithLines(db, result.estimateId!);
    expect(view?.version.state).toBe("LOCKED");
    expect(view?.version.versionNo).toBe(1);
    expect((view?.lines.length ?? 0)).toBeGreaterThan(0);

    // Session is now linked + confirmed.
    const session = await getChatSession(db, sessionId, USER.firebaseUid);
    expect(session?.enquiryId).toBe(result.enquiryId);
    expect(session?.slotState?.clientName).toMatchObject({ status: "confirmed" });
  });

  it("createEnquiryFromState: refuses an invalid state, and refuses a duplicate", async () => {
    const sessionId = "svc-create-bad";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    await updateSlotState(db, sessionId, USER.firebaseUid, applyExtracted(initSlotState(), { clientName: "Only a name" }));

    const bad = await servicesFor(sessionId).createEnquiryFromState(sessionId);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("expected refusal");
    expect(bad.issues.length).toBeGreaterThan(0);

    // Now make it valid + create, then a second create is refused (already linked).
    await updateSlotState(db, sessionId, USER.firebaseUid, fullSlotState());
    const ok = await servicesFor(sessionId).createEnquiryFromState(sessionId);
    expect(ok.ok).toBe(true);
    const dup = await servicesFor(sessionId).createEnquiryFromState(sessionId);
    expect(dup.ok).toBe(false);
    if (dup.ok) throw new Error("expected duplicate refusal");
    expect(dup.issues[0]).toMatch(/already created/);
  });

  // ── getEnquiryState / repair / reset round-trips ────────────────────────────

  it("getEnquiryState reports readiness, issues and missing fields", async () => {
    const readySession = "svc-state-ready";
    await getOrCreateChatSession(db, { sessionId: readySession, userId: USER.firebaseUid });
    await updateSlotState(db, readySession, USER.firebaseUid, fullSlotState());
    const ready = await servicesFor(readySession).getEnquiryState(readySession);
    expect(ready.readyToConfirm).toBe(true);
    expect(ready.issues).toEqual([]);
    expect(ready.missingRequired).toEqual([]);

    const partialSession = "svc-state-partial";
    await getOrCreateChatSession(db, { sessionId: partialSession, userId: USER.firebaseUid });
    await updateSlotState(db, partialSession, USER.firebaseUid, applyExtracted(initSlotState(), { clientName: "Acme" }));
    const partial = await servicesFor(partialSession).getEnquiryState(partialSession);
    expect(partial.readyToConfirm).toBe(false);
    expect(partial.missingRequired.length).toBeGreaterThan(0);
  });

  it("repairEnquiryState sets/clears fields and is blocked once an enquiry is linked", async () => {
    const sessionId = "svc-repair";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    await updateSlotState(db, sessionId, USER.firebaseUid, fullSlotState());

    const repaired = await servicesFor(sessionId).repairEnquiryState(sessionId, {
      set: { floorAreaSqm: 600 },
      clear: ["projectTier"],
    });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) throw new Error("expected ok");
    expect(repaired.snapshot.slots.floorAreaSqm.value).toBe(600);
    expect(repaired.snapshot.slots.projectTier.status).toBe("missing");

    // Once linked, repair is blocked.
    await linkSessionEnquiry(db, sessionId, USER.firebaseUid, "GBE-ENQ-2026-999");
    const blocked = await servicesFor(sessionId).repairEnquiryState(sessionId, { set: { floorsAbove: 9 } });
    expect(blocked.ok).toBe(false);
  });

  it("resetEnquiryCapture clears an unlinked session, refuses a linked one", async () => {
    const sessionId = "svc-reset";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    await updateSlotState(db, sessionId, USER.firebaseUid, fullSlotState());
    const snap = await servicesFor(sessionId).resetEnquiryCapture(sessionId);
    expect(snap.confirmed).toEqual([]);
    expect(snap.proposed).toEqual([]);
    const cleared = await getChatSession(db, sessionId, USER.firebaseUid);
    expect(cleared?.slotState).toBeNull();

    // Linked → refuse (state left intact, snapshot returned).
    await updateSlotState(db, sessionId, USER.firebaseUid, fullSlotState());
    await linkSessionEnquiry(db, sessionId, USER.firebaseUid, "GBE-ENQ-2026-998");
    await servicesFor(sessionId).resetEnquiryCapture(sessionId);
    const stillThere = await getChatSession(db, sessionId, USER.firebaseUid);
    expect(stillThere?.slotState?.clientName).toBeTruthy();
  });

  // ── contradiction counting ──────────────────────────────────────────────────

  it("updateEnquiryDraft increments contradictions when a confirmed slot is overwritten", async () => {
    const sessionId = "svc-contra";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    // Confirm a value, then re-state it differently.
    const confirmed = fullSlotState();
    for (const f of Object.keys(confirmed) as (keyof SlotState)[]) {
      if (confirmed[f].value !== null) confirmed[f] = { status: "confirmed", value: confirmed[f].value };
    }
    await updateSlotState(db, sessionId, USER.firebaseUid, confirmed);

    await servicesFor(sessionId).updateEnquiryDraft(sessionId, { floorsAbove: 8 });
    const after = await getChatSession(db, sessionId, USER.firebaseUid);
    expect(after?.contradictions).toBe(1);

    // Re-stating the SAME value is not a contradiction.
    await servicesFor(sessionId).updateEnquiryDraft(sessionId, { clientName: "Acme Fire Pvt Ltd" });
    const after2 = await getChatSession(db, sessionId, USER.firebaseUid);
    expect(after2?.contradictions).toBe(1);
  });

  // ── summary compaction ──────────────────────────────────────────────────────

  it("maybeRefreshSummary summarises older turns and advances the watermark", async () => {
    const sessionId = "svc-summary";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    for (let i = 0; i < 12; i += 1) {
      await appendChatMessage(db, {
        sessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i}`,
      });
    }
    const before = await getChatSession(db, sessionId, USER.firebaseUid);
    const all = await listChatMessages(db, sessionId, 100);

    await maybeRefreshSummary(
      { db, models: models({ classifier: generateStub("FACTS CAPTURED: 12 turns of Acme.") }), env: { PEBBLE_CHAT_WINDOW: "2" } },
      { sessionId, session: before! },
    );

    const after = await getChatSession(db, sessionId, USER.firebaseUid);
    expect(after?.summary).toMatch(/FACTS CAPTURED/);
    // Window 2 → the last 2 messages stay verbatim, so the watermark is the 10th message.
    expect(after?.summaryUptoMessageId).toBe(all[9]!.id);
  });

  // ── auto-title ────────────────────────────────────────────────────────────

  it("maybeGenerateTitle titles a fresh (first-exchange) session and ledgers a Gemini 'title' call", async () => {
    const sessionId = "svc-autotitle-direct";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    await appendChatMessage(db, { sessionId, role: "user", content: "4 storey office FAS enquiry" });
    await appendChatMessage(db, { sessionId, role: "assistant", content: "Sure, let's get started." });
    const session = await getChatSession(db, sessionId, USER.firebaseUid);

    await maybeGenerateTitle(
      { db, models: models({ classifier: generateStub("4-Storey Office FAS Enquiry") }) },
      {
        sessionId,
        session: session!,
        userText: "4 storey office FAS enquiry",
        assistantText: "Sure, let's get started.",
      },
    );

    const after = await getChatSession(db, sessionId, USER.firebaseUid);
    expect(after?.title).toBe("4-Storey Office FAS Enquiry");

    const rows = await db.select().from(schema.llmCalls);
    const titleCall = rows.find((r) => r.sessionId === sessionId && r.intent === "title");
    expect(titleCall?.lane).toBe("gemini");
  });

  it("maybeGenerateTitle is a no-op once the session already has a title", async () => {
    const sessionId = "svc-autotitle-existing";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    await renameChatSession(db, { sessionId, userId: USER.firebaseUid, title: "Existing Title" });
    const session = await getChatSession(db, sessionId, USER.firebaseUid);

    await maybeGenerateTitle(
      { db, models: models({ classifier: generateStub("Should Not Be Used") }) },
      { sessionId, session: session!, userText: "another message", assistantText: "another reply" },
    );

    expect((await getChatSession(db, sessionId, USER.firebaseUid))?.title).toBe("Existing Title");
  });

  it("maybeGenerateTitle is a no-op once more than the first exchange has landed", async () => {
    const sessionId = "svc-autotitle-late";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    // Three exchanges already on the row (6 messages) — past the "first exchange" window.
    for (let i = 0; i < 6; i += 1) {
      await appendChatMessage(db, {
        sessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i}`,
      });
    }
    const session = await getChatSession(db, sessionId, USER.firebaseUid);

    await maybeGenerateTitle(
      { db, models: models({ classifier: generateStub("Too Late Title") }) },
      { sessionId, session: session!, userText: "turn 6", assistantText: "turn 7" },
    );

    expect((await getChatSession(db, sessionId, USER.firebaseUid))?.title).toBeNull();
  });

  // ── escalation model selection + budget suppression ─────────────────────────

  it("escalation: a challenge on a linked estimate selects Opus", async () => {
    const sessionId = "agent-esc-opus";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    await updateSlotState(db, sessionId, USER.firebaseUid, fullSlotState());
    await servicesFor(sessionId).createEnquiryFromState(sessionId); // links a real enquiry + estimate

    const dflt = streamStub("claude-sonnet-4-6", [{ text: "default reply" }]);
    const opus = streamStub("claude-opus-4-8", [{ text: "Per DL-FAS-001 the count holds." }]);
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: dflt.model, claudeOpus: opus.model }) },
      { sessionId, message: "this total looks too high to me", user: actor },
    );
    await drainBody(res);
    await waitFor(async () => {
      const msgs = await listChatMessages(db, sessionId, 100);
      return msgs.find((m) => m.role === "assistant" && m.content.includes("DL-FAS-001"));
    });
    expect(opus.invoked.count).toBe(1);
    expect(dflt.invoked.count).toBe(0);
  });

  it("escalation: past the Opus daily cap it stays on default and ledgers the suppression", async () => {
    const sessionId = "agent-esc-supp";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    await updateSlotState(db, sessionId, USER.firebaseUid, fullSlotState());
    await servicesFor(sessionId).createEnquiryFromState(sessionId);
    // Blow past the $1 daily Opus cap for this user.
    await insertLlmCall(db, {
      sessionId,
      lane: "claude",
      model: "claude-opus-4-8",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 2,
    });

    const dflt = streamStub("claude-sonnet-4-6", [{ text: "Let me walk you through it." }]);
    const opus = streamStub("claude-opus-4-8", [{ text: "opus reply" }]);
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: dflt.model, claudeOpus: opus.model }) },
      { sessionId, message: "this is way too high, it's wrong", user: actor },
    );
    await drainBody(res);
    // The suppression is ledgered as the turn's intent on the fresh Sonnet call.
    const suppressed = await waitFor(async () => {
      const rows = await db.select().from(schema.llmCalls);
      return rows.find((r) => r.sessionId === sessionId && (r.intent ?? "").startsWith("agent-suppressed:budget"));
    });
    expect(suppressed).toBeTruthy();
    expect(dflt.invoked.count).toBe(1);
    expect(opus.invoked.count).toBe(0);
  });

  // ── assistant text + parts persistence ──────────────────────────────────────

  it("persists assistant text and ledgers a plain agent turn (no tools)", async () => {
    const sessionId = "agent-happy";
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: streamStub("claude-sonnet-4-6", [{ text: "Hello — how can I help?" }]).model }) },
      { sessionId, message: "hi there", user: actor },
    );
    await drainBody(res);
    const assistant = await waitFor(async () => {
      const msgs = await listChatMessages(db, sessionId, 100);
      return msgs.find((m) => m.role === "assistant");
    });
    expect(assistant.content).toContain("how can I help");
    expect(assistant.lane).toBe("claude");
    expect(assistant.model).toBe("claude-sonnet-4-6");
  });

  it("ledgers the Anthropic cache read/write token counts on the turn", async () => {
    const sessionId = "agent-cache-ledger";
    const res = await runAgentTurn(
      {
        db,
        models: models({
          claudeDefault: streamStub("claude-sonnet-4-6", [{ text: "cached hello" }], {
            read: 25,
            write: 40,
          }).model,
        }),
      },
      { sessionId, message: "hi cached", user: actor },
    );
    await drainBody(res);
    const row = await waitFor(async () => {
      const rows = await db.select().from(schema.llmCalls);
      return rows.find((r) => r.sessionId === sessionId) ?? null;
    });
    expect(row.cacheReadTokens).toBe(25);
    expect(row.cacheWriteTokens).toBe(40);
  });

  it("persists tool-activity parts for a tool-using turn", async () => {
    const sessionId = "agent-parts";
    const script: ScriptTurn[] = [
      { toolCall: { toolName: "get_design_rules", input: { systemType: null } } },
      { text: "Those are the active design rules." },
    ];
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: streamStub("claude-sonnet-4-6", script).model }) },
      { sessionId, message: "what design rules apply?", user: actor },
    );
    await drainBody(res);
    const assistant = await waitFor(async () => {
      const msgs = await listChatMessages(db, sessionId, 100);
      const a = msgs.find((m) => m.role === "assistant");
      return a?.parts ? a : null;
    });
    const partTypes = (assistant.parts as Array<{ type: string; state?: string }>).map((p) => p.type);
    expect(partTypes).toContain("tool-get_design_rules");
    const toolPart = (assistant.parts as Array<{ type: string; state?: string }>).find(
      (p) => p.type === "tool-get_design_rules",
    );
    expect(toolPart?.state).toBe("output-available");
  });

  // ── auto-title, end to end via runAgentTurn's onFinish ──────────────────────

  it("runAgentTurn onFinish auto-titles a brand-new session after the first exchange (fire-and-forget)", async () => {
    const sessionId = "agent-autotitle-e2e";
    const res = await runAgentTurn(
      {
        db,
        models: models({
          claudeDefault: streamStub("claude-sonnet-4-6", [{ text: "Sure, let's get started." }]).model,
          classifier: generateStub("4-Storey Office FAS Enquiry"),
        }),
      },
      { sessionId, message: "I need a quote for a 4-storey office", user: actor },
    );
    await drainBody(res);

    // Auto-title is fire-and-forget (not awaited by onFinish), so poll for it.
    const titled = await waitFor(async () => {
      const session = await getChatSession(db, sessionId, USER.firebaseUid);
      return session?.title ? session : null;
    });
    expect(titled.title).toBe("4-Storey Office FAS Enquiry");

    const rows = await db.select().from(schema.llmCalls);
    const titleCall = rows.find((r) => r.sessionId === sessionId && r.intent === "title");
    expect(titleCall).toBeTruthy();
    expect(titleCall?.lane).toBe("gemini");
  });

  it("runAgentTurn onFinish leaves a pre-titled session's title untouched", async () => {
    const sessionId = "agent-autotitle-e2e-existing";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    await renameChatSession(db, { sessionId, userId: USER.firebaseUid, title: "Existing Title" });

    const res = await runAgentTurn(
      {
        db,
        models: models({
          claudeDefault: streamStub("claude-sonnet-4-6", [{ text: "Continuing the conversation." }]).model,
          classifier: generateStub("Should Not Be Used"),
        }),
      },
      { sessionId, message: "another message", user: actor },
    );
    await drainBody(res);

    // Wait for the turn to fully persist (proxy for onFinish having run, including
    // the fire-and-forget auto-title attempt it kicks off), then assert unchanged.
    await waitFor(async () => {
      const msgs = await listChatMessages(db, sessionId, 100);
      return msgs.find((m) => m.role === "assistant" && m.content.includes("Continuing")) ?? null;
    });
    await new Promise((r) => setTimeout(r, 25)); // let any (incorrect) fire-and-forget settle
    expect((await getChatSession(db, sessionId, USER.firebaseUid))?.title).toBe("Existing Title");
  });

  // ── guards ──────────────────────────────────────────────────────────────────

  it("returns 429 when the daily budget is exhausted", async () => {
    const sessionId = "agent-budget";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    await insertLlmCall(db, {
      sessionId,
      lane: "claude",
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 99,
    });
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: streamStub("claude-sonnet-4-6", [{ text: "hi" }]).model }), env: { PEBBLE_DAILY_LLM_BUDGET_USD: "5" } },
      { sessionId, message: "hello", user: actor },
    );
    expect(res.status).toBe(429);
  });

  it("returns 503 when no Claude model is configured", async () => {
    // High budget so the (shared-user) budget guard passes and we reach the model check.
    const res = await runAgentTurn(
      { db, models: models(), env: { PEBBLE_DAILY_LLM_BUDGET_USD: "1000000" } },
      { sessionId: "agent-503", message: "hello", user: actor },
    );
    expect(res.status).toBe(503);
  });
});
