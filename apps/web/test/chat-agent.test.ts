import {
  ADVISOR_UNSUPPORTED_WARNING,
  applyExtracted,
  initSlotState,
  TOOL_SEARCH_UNSUPPORTED_WARNING,
  type ChatModels,
  type SlotState,
} from "@pebble/ai";
import {
  appendChatMessage,
  createDb,
  getChatSession,
  getOrCreateChatSession,
  getVersionWithLines,
  insertChatAttachment,
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
import type { PutResult, StorageAdapter } from "@pebble/worker";
import type { LanguageModel } from "ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAiServices } from "../src/server/ai-services";
import {
  maybeGenerateTitle,
  maybeRefreshSummary,
  persistAbortedTurn,
  runAgentTurn,
} from "../src/server/chat-agent";

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

type ScriptTurn =
  | { text: string }
  | { toolCall: { toolName: string; input: unknown } }
  // A step whose model stream never produces and simply waits for the request's
  // abort signal, then throws an AbortError (like a real provider on disconnect)
  // — used to exercise the WP13 abort-persistence path.
  | { blockUntilAbort: true };

/**
 * A streaming LanguageModel stub: one scripted turn per `doStream` (= per agent
 * step). `cache` (optional) makes each step report Anthropic prompt-cache usage
 * — `read` on the shared usage object (surfaces as `totalUsage.cachedInputTokens`)
 * and `write` via provider metadata (`cache_creation_input_tokens`), so the
 * ledger's cache-token columns can be exercised.
 *
 * `blocked` resolves the moment a `blockUntilAbort` step's `doStream` is reached
 * (so a test can deterministically abort once the model has started the step
 * that will be interrupted).
 */
function streamStub(
  modelId: string,
  script: ScriptTurn[],
  cache?: { read?: number; write?: number },
  // WP12: optional advisor sub-inference iterations emitted on the finish chunk's
  // `providerMetadata.anthropic.iterations`, so the onFinish advisor-iteration
  // ledgering can be exercised from a synthetic payload.
  iterations?: unknown[],
) {
  const invoked = { count: 0 };
  // WP10: the raw `prompt` (AI SDK's LanguageModelV2 message array) from the
  // MOST RECENT `doStream` call, so a test can assert what `providerOptions`
  // (i.e. cache_control breakpoints) actually reached the model — the two
  // breakpoints' ttl threading is otherwise invisible from the outside.
  const lastCall: { prompt: unknown } = { prompt: null };
  let step = 0;
  let resolveBlocked: () => void = () => {};
  const blocked = new Promise<void>((r) => {
    resolveBlocked = r;
  });
  const usage = {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    ...(cache?.read ? { cachedInputTokens: cache.read } : {}),
  };
  const finish = (finishReason: string): Record<string, unknown> => {
    const anthropicMeta: Record<string, unknown> = {};
    if (cache?.write) anthropicMeta.usage = { cache_creation_input_tokens: cache.write };
    if (iterations) anthropicMeta.iterations = iterations;
    return {
      type: "finish",
      finishReason,
      usage,
      ...(Object.keys(anthropicMeta).length > 0 ? { providerMetadata: { anthropic: anthropicMeta } } : {}),
    };
  };
  const model = {
    specificationVersion: "v2",
    provider: "test",
    modelId,
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("doGenerate not used in the streaming agent");
    },
    doStream: async (opts: { abortSignal?: AbortSignal; prompt?: unknown }) => {
      invoked.count += 1;
      lastCall.prompt = opts.prompt ?? null;
      const turn = script[Math.min(step, script.length - 1)]!;
      step += 1;
      if ("blockUntilAbort" in turn) {
        const signal = opts.abortSignal;
        resolveBlocked();
        const stream = new ReadableStream<Record<string, unknown>>({
          pull() {
            return new Promise<void>((_resolve, reject) => {
              if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
              signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            });
          },
        });
        return { stream };
      }
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
  return { model, invoked, blocked, lastCall };
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

  // ── cache ttl threading (WP10) ───────────────────────────────────────────

  /** Every message in `prompt` carrying an Anthropic ephemeral cache_control breakpoint. */
  function cacheBreakpoints(
    prompt: unknown,
  ): Array<{ type: string; ttl?: string }> {
    const arr = prompt as Array<{ providerOptions?: { anthropic?: { cacheControl?: { type: string; ttl?: string } } } }>;
    return arr
      .map((m) => m.providerOptions?.anthropic?.cacheControl)
      .filter((cc): cc is { type: string; ttl?: string } => cc != null);
  }

  it("defaults to the 5-minute breakpoint (no ttl key) on both breakpoints", async () => {
    const sessionId = "agent-cache-ttl-default";
    const stub = streamStub("claude-sonnet-4-6", [{ text: "hi" }]);
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: stub.model }) },
      { sessionId, message: "hello", user: actor },
    );
    await drainBody(res);
    await waitFor(async () => (stub.lastCall.prompt ? true : null));

    const breakpoints = cacheBreakpoints(stub.lastCall.prompt);
    // Breakpoint 1 (digest) + breakpoint 2 (the current user message).
    expect(breakpoints.length).toBe(2);
    for (const bp of breakpoints) {
      expect(bp.type).toBe("ephemeral");
      expect(bp.ttl).toBeUndefined();
    }
  });

  it("PEBBLE_CACHE_TTL=1h puts ttl:1h on BOTH breakpoints", async () => {
    const sessionId = "agent-cache-ttl-1h";
    const stub = streamStub("claude-sonnet-4-6", [{ text: "hi" }]);
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: stub.model }), env: { PEBBLE_CACHE_TTL: "1h" } },
      { sessionId, message: "hello", user: actor },
    );
    await drainBody(res);
    await waitFor(async () => (stub.lastCall.prompt ? true : null));

    const breakpoints = cacheBreakpoints(stub.lastCall.prompt);
    expect(breakpoints.length).toBe(2);
    for (const bp of breakpoints) {
      expect(bp.type).toBe("ephemeral");
      expect(bp.ttl).toBe("1h");
    }
  });

  it("ledgers a higher cost for the SAME cache write under the 1h ttl than the 5m default", async () => {
    const write = 100_000;
    const sessionId5m = "agent-cache-cost-5m";
    const res5m = await runAgentTurn(
      {
        db,
        models: models({
          claudeDefault: streamStub("claude-sonnet-4-6", [{ text: "hi" }], { write }).model,
        }),
      },
      { sessionId: sessionId5m, message: "hello", user: actor },
    );
    await drainBody(res5m);
    const row5m = await waitFor(async () => {
      const rows = await db.select().from(schema.llmCalls);
      return rows.find((r) => r.sessionId === sessionId5m) ?? null;
    });

    const sessionId1h = "agent-cache-cost-1h";
    const res1h = await runAgentTurn(
      {
        db,
        models: models({
          claudeDefault: streamStub("claude-sonnet-4-6", [{ text: "hi" }], { write }).model,
        }),
        env: { PEBBLE_CACHE_TTL: "1h" },
      },
      { sessionId: sessionId1h, message: "hello", user: actor },
    );
    await drainBody(res1h);
    const row1h = await waitFor(async () => {
      const rows = await db.select().from(schema.llmCalls);
      return rows.find((r) => r.sessionId === sessionId1h) ?? null;
    });

    expect(row5m.cacheWriteTokens).toBe(write);
    expect(row1h.cacheWriteTokens).toBe(write);
    // 1h writes bill at 2x the input rate vs 1.25x for 5m — same write tokens,
    // strictly higher ledgered cost.
    expect(Number(row1h.costUsd)).toBeGreaterThan(Number(row5m.costUsd));
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

  it("ends the turn at an ask_user clarification, persisting the part + a [Asked:] content suffix", async () => {
    const sessionId = "agent-ask-user";
    const askInput = {
      question: "Which building type is this?",
      options: [
        { label: "Commercial", detail: "offices, retail, mixed-use" },
        { label: "Residential" },
      ],
      allowFreeText: true,
    };
    // The model calls ask_user (no executor) — the turn must end AT the call,
    // so this single scripted step is the only one that runs.
    const stub = streamStub("claude-sonnet-4-6", [
      { toolCall: { toolName: "ask_user", input: askInput } },
    ]);
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: stub.model }) },
      { sessionId, message: "I need an estimate for a new building", user: actor },
    );
    await drainBody(res);

    const assistant = await waitFor(async () => {
      const msgs = await listChatMessages(db, sessionId, 100);
      const a = msgs.find((m) => m.role === "assistant");
      return a?.parts ? a : null;
    });

    // The turn stopped at the clarification — exactly one model step ran.
    expect(stub.invoked.count).toBe(1);

    // The part round-trips as tool-ask_user with state input-available (no result).
    const parts = assistant.parts as Array<{ type: string; state?: string; input?: unknown }>;
    const askPart = parts.find((p) => p.type === "tool-ask_user");
    expect(askPart).toBeTruthy();
    expect(askPart?.state).toBe("input-available");
    expect(askPart?.input).toEqual(askInput);

    // The content text carries the [Asked: …] suffix (persistence-only) so the
    // model sees its own question when the next turn's history is rebuilt.
    expect(assistant.content).toContain(
      "[Asked: Which building type is this? — options: Commercial | Residential]",
    );
  });

  // ── abort persistence (WP13) ────────────────────────────────────────────────

  it("persistAbortedTurn writes the partial text + a data-stopped marker and ledgers agent-aborted", async () => {
    const sessionId = "agent-abort-direct";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    // Fabricate the finished steps the SDK would hand `onAbort` (text produced
    // before the interrupted step).
    const steps = [
      {
        content: [{ type: "text", text: "Let me check the design rules." }],
        text: "Let me check the design rules.",
        usage: { inputTokens: 50, outputTokens: 12 },
      },
    ] as unknown as Parameters<typeof persistAbortedTurn>[1]["steps"];

    await persistAbortedTurn(
      { db, models: models() },
      { sessionId, steps, modelId: "claude-sonnet-4-6", reasons: [] },
    );

    const msgs = await listChatMessages(db, sessionId, 100);
    const assistant = msgs.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("Let me check the design rules.\n\n(stopped)");
    const parts = assistant.parts as Array<Record<string, unknown>>;
    expect(parts.some((p) => p.type === "text")).toBe(true);
    expect(parts[parts.length - 1]).toEqual({ type: "data-stopped", v: 1 });

    const rows = await db.select().from(schema.llmCalls);
    const ledger = rows.find((r) => r.sessionId === sessionId);
    expect(ledger?.intent).toBe("agent-aborted");
    expect(ledger?.lane).toBe("claude");
    // No summary/title Gemini calls on an aborted turn.
    expect(rows.filter((r) => r.sessionId === sessionId && r.lane === "gemini")).toEqual([]);
  });

  it("runAgentTurn persists the partial turn on a real abort (tool step done, text step interrupted) — no title/summary", async () => {
    const sessionId = "agent-abort-e2e";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    const script: ScriptTurn[] = [
      { toolCall: { toolName: "get_design_rules", input: { systemType: null } } },
      { blockUntilAbort: true }, // the text step that gets aborted mid-flight
    ];
    const stub = streamStub("claude-sonnet-4-6", script);
    const controller = new AbortController();

    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: stub.model, classifier: generateStub("SHOULD NOT TITLE") }) },
      { sessionId, message: "what design rules apply?", user: actor, abortSignal: controller.signal },
    );
    // Drain in the background so the agent loop advances to the second step,
    // then abort deterministically once that step has begun.
    const drained = drainBody(res);
    await stub.blocked;
    controller.abort();
    await drained;

    const assistant = await waitFor(async () => {
      const msgs = await listChatMessages(db, sessionId, 100);
      const a = msgs.find((m) => m.role === "assistant");
      return a?.parts ? a : null;
    });

    // The finished tool step survived, the marker closes the turn, and the
    // content carries the (stopped) suffix.
    const parts = assistant.parts as Array<Record<string, unknown>>;
    expect(parts.some((p) => p.type === "tool-get_design_rules")).toBe(true);
    expect(parts[parts.length - 1]).toEqual({ type: "data-stopped", v: 1 });
    expect(assistant.content).toContain("(stopped)");

    const rows = await db.select().from(schema.llmCalls);
    expect(
      rows.some((r) => r.sessionId === sessionId && (r.intent ?? "").startsWith("agent-aborted")),
    ).toBe(true);

    // The turn was aborted, so no auto-title and no Gemini calls, even after a
    // grace period for any (incorrect) fire-and-forget work to settle.
    await new Promise((r) => setTimeout(r, 40));
    expect((await getChatSession(db, sessionId, USER.firebaseUid))?.title).toBeNull();
    expect((await db.select().from(schema.llmCalls)).filter(
      (r) => r.sessionId === sessionId && r.lane === "gemini",
    )).toEqual([]);
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
    const now = new Date("2026-07-19T15:42:11.000Z");
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: streamStub("claude-sonnet-4-6", [{ text: "hi" }]).model }), env: { PEBBLE_DAILY_LLM_BUDGET_USD: "5" }, now },
      { sessionId, message: "hello", user: actor },
    );
    expect(res.status).toBe(429);
    // WP13: the 429 body carries the next-UTC-midnight reset instant so the
    // client can render a live "resets in …" countdown.
    const body = (await res.json()) as { error: string; resetsAtISO: string };
    expect(body.error).toBe("daily_budget_exceeded");
    expect(body.resetsAtISO).toBe("2026-07-20T00:00:00.000Z");
  });

  it("returns 503 when no Claude model is configured", async () => {
    // High budget so the (shared-user) budget guard passes and we reach the model check.
    const res = await runAgentTurn(
      { db, models: models(), env: { PEBBLE_DAILY_LLM_BUDGET_USD: "1000000" } },
      { sessionId: "agent-503", message: "hello", user: actor },
    );
    expect(res.status).toBe(503);
  });

  // ── attachments (WP8): resolution, cost guard, file-part persistence ────────

  /** In-memory storage returning canned bytes for any uri (agent reads attachments through it). */
  function memoryStorage(bytesByUri: Record<string, Uint8Array> = {}): StorageAdapter {
    return {
      async put(key: string, bytes: Buffer | Uint8Array): Promise<PutResult> {
        bytesByUri[`mem://${key}`] = Buffer.from(bytes);
        return { uri: `mem://${key}`, sha256: "stub" };
      },
      async signedUrl(uri: string) {
        return uri;
      },
      async get(uri: string): Promise<Buffer> {
        const found = bytesByUri[uri];
        if (!found) throw new Error(`no object at ${uri}`);
        return Buffer.from(found);
      },
      keyToUri: (key: string) => `mem://${key}`,
    };
  }

  async function seedAttachment(args: {
    sessionId: string;
    filename: string;
    mediaType: string;
    storageUri: string;
    pageCount?: number | null;
    status?: string;
  }): Promise<string> {
    const row = await insertChatAttachment(db, {
      sessionId: args.sessionId,
      userId: USER.firebaseUid,
      filename: args.filename,
      mediaType: args.mediaType,
      sizeBytes: 1000,
      sha256: `sha-${args.filename}-${Math.random()}`,
      storageUri: args.storageUri,
      pageCount: args.pageCount ?? null,
      status: args.status ?? "READY",
    });
    return row.id;
  }

  it("refuses an over-budget attachment batch (413) before any model call, without persisting the turn", async () => {
    const sessionId = "agent-attach-toobig";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    // 30-page PDF → 75_000 tokens > 60_000 limit.
    const id = await seedAttachment({
      sessionId,
      filename: "huge.pdf",
      mediaType: "application/pdf",
      storageUri: "file:///tmp/huge.pdf",
      pageCount: 30,
    });
    const dflt = streamStub("claude-sonnet-4-6", [{ text: "should not run" }]);
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: dflt.model }), storage: memoryStorage(), env: { PEBBLE_DAILY_LLM_BUDGET_USD: "1000000" } },
      { sessionId, message: "read this", user: actor, attachmentIds: [id] },
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("attachment_too_large");
    expect(body.message).toContain("huge.pdf");
    // The model never ran and no user turn was persisted.
    expect(dflt.invoked.count).toBe(0);
    expect(await listChatMessages(db, sessionId, 100)).toEqual([]);
  });

  it("404s an unknown/foreign attachment id", async () => {
    const sessionId = "agent-attach-unknown";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: streamStub("claude-sonnet-4-6", [{ text: "hi" }]).model }), storage: memoryStorage(), env: { PEBBLE_DAILY_LLM_BUDGET_USD: "1000000" } },
      { sessionId, message: "read this", user: actor, attachmentIds: ["does-not-exist"] },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("attachment_not_found");
  });

  it("persists file parts on the user row and embeds a readable text attachment", async () => {
    const sessionId = "agent-attach-ok";
    await getOrCreateChatSession(db, { sessionId, userId: USER.firebaseUid });
    const bytes: Record<string, Uint8Array> = {
      "file:///tmp/notes.txt": new TextEncoder().encode("client wants FAS on 4 floors"),
    };
    const id = await seedAttachment({
      sessionId,
      filename: "notes.txt",
      mediaType: "text/plain",
      storageUri: "file:///tmp/notes.txt",
    });
    const dflt = streamStub("claude-sonnet-4-6", [{ text: "Got your notes." }]);
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: dflt.model }), storage: memoryStorage(bytes), env: { PEBBLE_DAILY_LLM_BUDGET_USD: "1000000" } },
      { sessionId, message: "here are the details", user: actor, attachmentIds: [id] },
    );
    await drainBody(res);
    const userRow = await waitFor(async () => {
      const msgs = await listChatMessages(db, sessionId, 100);
      return msgs.find((m) => m.role === "user" && Array.isArray(m.parts)) ?? null;
    });
    expect(userRow.parts).toEqual([
      { type: "file", filename: "notes.txt", mediaType: "text/plain", attachmentId: id, v: 1 },
    ]);
    expect(dflt.invoked.count).toBe(1);
  });

  // ── WP11 tool-search pilot flag (functionally off: provider unsupported) ─────
  it("PEBBLE_TOOL_SEARCH=1 logs the unsupported warning once and still streams a full turn", async () => {
    const sessionId = "agent-tool-search-on";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const stub = streamStub("claude-sonnet-4-6", [{ text: "hi" }]);
      const res = await runAgentTurn(
        {
          db,
          models: models({ claudeDefault: stub.model }),
          env: { PEBBLE_TOOL_SEARCH: "1", PEBBLE_DAILY_LLM_BUDGET_USD: "1000000" },
        },
        { sessionId, message: "hello", user: actor },
      );
      await drainBody(res);
      await waitFor(async () => (stub.lastCall.prompt ? true : null));
      // The installed @ai-sdk/anthropic ships no tool-search factory, so the flag
      // warns and stays functionally off — the turn still runs to completion.
      const warned = warn.mock.calls.filter((c) => String(c[0]).includes(TOOL_SEARCH_UNSUPPORTED_WARNING));
      expect(warned.length).toBe(1);
      expect(stub.invoked.count).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT log the tool-search warning when the flag is off", async () => {
    const sessionId = "agent-tool-search-off";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const stub = streamStub("claude-sonnet-4-6", [{ text: "hi" }]);
      const res = await runAgentTurn(
        { db, models: models({ claudeDefault: stub.model }), env: { PEBBLE_DAILY_LLM_BUDGET_USD: "1000000" } },
        { sessionId, message: "hello", user: actor },
      );
      await drainBody(res);
      await waitFor(async () => (stub.lastCall.prompt ? true : null));
      expect(warn.mock.calls.some((c) => String(c[0]).includes(TOOL_SEARCH_UNSUPPORTED_WARNING))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  // ── WP12 advisor pilot (functionally the model switch: provider unsupported) ─
  //
  // A dedicated user keeps the Opus daily budget fresh: the shared USER
  // accumulates Opus spend/turns across the suite (the suppression test blows the
  // $1 cap), which would otherwise suppress the escalation this test relies on.
  const ADVISOR_USER: AppUser = {
    firebaseUid: "agent-advisor-user",
    email: "advisor@greenberg.test",
    displayName: "Advisor User",
    role: "estimator",
    active: true,
  };
  const advisorActor = { firebaseUid: ADVISOR_USER.firebaseUid, role: ADVISOR_USER.role };
  function advisorServicesFor(sessionId: string) {
    return createAiServices({
      db,
      actor: ADVISOR_USER.firebaseUid,
      actorRole: ADVISOR_USER.role,
      sessionId,
    });
  }

  it("PEBBLE_ADVISOR=1 + escalation on the installed provider: warns once and falls back to the Opus switch", async () => {
    await upsertUser(db, ADVISOR_USER);
    const sessionId = "agent-advisor-unsupported";
    await getOrCreateChatSession(db, { sessionId, userId: ADVISOR_USER.firebaseUid });
    await updateSlotState(db, sessionId, ADVISOR_USER.firebaseUid, fullSlotState());
    await advisorServicesFor(sessionId).createEnquiryFromState(sessionId); // links an estimate → a challenge escalates

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dflt = streamStub("claude-sonnet-4-6", [{ text: "default reply" }]);
      const opus = streamStub("claude-opus-4-8", [{ text: "Per DL-FAS-001 the count holds." }]);
      const res = await runAgentTurn(
        {
          db,
          models: models({ claudeDefault: dflt.model, claudeOpus: opus.model }),
          env: { PEBBLE_ADVISOR: "1", PEBBLE_DAILY_LLM_BUDGET_USD: "1000000" },
        },
        { sessionId, message: "this total looks too high to me", user: advisorActor },
      );
      await drainBody(res);
      const row = await waitFor(async () => {
        const rows = await db.select().from(schema.llmCalls);
        return rows.find((r) => r.sessionId === sessionId && (r.intent ?? "").startsWith("agent-opus")) ?? null;
      });
      // Behaviour identical to the deterministic switch: Opus ran, Sonnet did not,
      // the intent is the plain agent-opus label (NOT agent-advisor), and the
      // unsupported warning was logged exactly once.
      expect(opus.invoked.count).toBe(1);
      expect(dflt.invoked.count).toBe(0);
      expect(row.intent).toBe("agent-opus:challenge");
      const warned = warn.mock.calls.filter((c) => String(c[0]).includes(ADVISOR_UNSUPPORTED_WARNING));
      expect(warned.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("ledgers one opus-rate advisor-iteration row per advisor_message in providerMetadata (executor row unchanged)", async () => {
    const sessionId = "agent-advisor-iterations";
    // A synthetic providerMetadata payload: an executor `message` iteration plus
    // two advisor sub-inferences. The onFinish advisor ledgering is UNCONDITIONAL
    // (defensive) — it fires whenever the provider reports advisor iterations.
    const iterations = [
      { type: "message", model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 20 },
      { type: "advisor_message", model: "claude-opus-4-8", inputTokens: 500, outputTokens: 80 },
      { type: "advisor_message", model: "claude-opus-4-8", inputTokens: 300, outputTokens: 40 },
    ];
    const stub = streamStub("claude-sonnet-4-6", [{ text: "advised reply" }], undefined, iterations);
    const res = await runAgentTurn(
      { db, models: models({ claudeDefault: stub.model }), env: { PEBBLE_DAILY_LLM_BUDGET_USD: "1000000" } },
      { sessionId, message: "hello", user: actor },
    );
    await drainBody(res);

    const advisorRows = await waitFor(async () => {
      const all = await db.select().from(schema.llmCalls);
      const rows = all.filter((r) => r.sessionId === sessionId && r.intent === "advisor-iteration");
      return rows.length === 2 ? rows : null;
    });
    const byIn = [...advisorRows].sort((a, b) => (b.inputTokens ?? 0) - (a.inputTokens ?? 0));
    expect(byIn.map((r) => r.model)).toEqual(["claude-opus-4-8", "claude-opus-4-8"]);
    expect(byIn.map((r) => r.inputTokens)).toEqual([500, 300]);
    expect(byIn.map((r) => r.outputTokens)).toEqual([80, 40]);
    // Priced at the OPUS rate (in 15 $/M, out 75 $/M): 500/1e6*15 + 80/1e6*75 = 0.0135
    // (the Sonnet rate would be 0.0027 — the assertion pins the opus rate).
    expect(Number(byIn[0]!.costUsd)).toBeCloseTo(0.0135, 6);

    // The executor row is a plain Sonnet agent turn, unchanged by the advisor rows.
    const all = await db.select().from(schema.llmCalls);
    const executor = all.find((r) => r.sessionId === sessionId && (r.intent ?? "").startsWith("agent["));
    expect(executor).toBeTruthy();
    expect(executor!.model).toBe("claude-sonnet-4-6");
  });

  it("does NOT log the advisor warning or ledger advisor rows when the flag is off", async () => {
    const sessionId = "agent-advisor-off";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const stub = streamStub("claude-sonnet-4-6", [{ text: "hi" }]);
      const res = await runAgentTurn(
        { db, models: models({ claudeDefault: stub.model }), env: { PEBBLE_DAILY_LLM_BUDGET_USD: "1000000" } },
        { sessionId, message: "hello", user: actor },
      );
      await drainBody(res);
      await waitFor(async () => (stub.lastCall.prompt ? true : null));
      expect(warn.mock.calls.some((c) => String(c[0]).includes(ADVISOR_UNSUPPORTED_WARNING))).toBe(false);
      const all = await db.select().from(schema.llmCalls);
      expect(all.some((r) => r.sessionId === sessionId && r.intent === "advisor-iteration")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
