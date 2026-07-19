import "server-only";

import {
  buildSessionStateBlock,
  chatWindowFromEnv,
  composeAgent,
  decideEscalation,
  module02Toolset,
  modelConfigFromEnv,
  opusCapFromEnv,
  PEBBLE_PERSONA,
  refreshSummary,
  shouldRefreshSummary,
  toLlmCallLog,
  type ChatModels,
} from "@pebble/ai";
import {
  appendChatMessage,
  countMessagesAfter,
  getOrCreateChatSession,
  insertLlmCall,
  listChatMessages,
  sumOpusSpendSince,
  updateSessionSummary,
  type ChatSessionRow,
  type Db,
} from "@pebble/db";
import {
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { createAiServices } from "@/server/ai-services";
import {
  checkDailyBudget,
  MODEL_UNCONFIGURED_MESSAGE,
  resolveSlotState,
  startOfUtcDayISO,
} from "@/server/chat-runtime";
import { getCachedDigest } from "@/server/digest-cache";

/**
 * Conversational chat turn (Phase C.5). Node runtime — PGlite/pg, engines and
 * the AI SDK are node-only. Streaming happens over this plain route handler
 * (tRPC covers the typed control-plane in routers/chat.ts).
 *
 * ONE agent turn, no lanes: a budget guard (429) and a deterministic escalation
 * pre-check pick Sonnet 5 or Opus 4.8; `composeAgent` folds the persona, the
 * Module-02 toolset and the cached master digest into the system prefix; the
 * running summary + last-N verbatim turns + a session-state block form the fresh
 * suffix. `streamText` (stepCountIs 8) is the ONLY author of visible text; every
 * number it states must come from a tool result, the digest, or the user. On
 * finish we persist the assistant text + UI parts, ledger the call, and refresh
 * the running summary via Gemini Flash once enough turns have accumulated.
 *
 * The core turn logic is the exported `runAgentTurn` (testable without HTTP);
 * the `POST` handler in `app/api/chat/route.ts` is a thin auth + parse wrapper
 * around it. This module lives under `src/server` (not the route file itself)
 * because Next.js only permits route files to export HTTP handlers + config.
 */

export const bodySchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
});

export function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface RunAgentTurnDeps {
  db: Db;
  models: ChatModels;
  env?: Record<string, string | undefined>;
  now?: Date;
}

export interface RunAgentTurnArgs {
  sessionId: string;
  message: string;
  user: { firebaseUid: string; role: string | null };
}

/**
 * The single agent turn, independent of HTTP. Returns the streaming
 * UI-message-stream `Response` on the happy path, or a plain JSON `Response`
 * for the budget (429) / model-unconfigured (503) guards. Every side effect
 * (persist, ledger, summary) happens on the stream's `onFinish`, wrapped so it
 * can never break the stream.
 */
export async function runAgentTurn(deps: RunAgentTurnDeps, args: RunAgentTurnArgs): Promise<Response> {
  const { db, models } = deps;
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const { sessionId, message, user } = args;

  // 1. Ensure the session row exists (slot state + summary + contradictions + link).
  const session = await getOrCreateChatSession(db, { sessionId, userId: user.firebaseUid });

  // 2. Daily budget guard (per-user, since UTC midnight).
  const budget = await checkDailyBudget(db, { userId: user.firebaseUid, now, env });
  if (budget.blocked) {
    return jsonResponse(429, {
      error: "daily_budget_exceeded",
      message: `Daily AI budget of $${budget.budgetUsd.toFixed(2)} reached (spent $${budget.spentUsd.toFixed(2)}). It resets at UTC midnight.`,
      spentUsd: budget.spentUsd,
      budgetUsd: budget.budgetUsd,
    });
  }

  // 3. Escalation pre-check → Sonnet 5 (default) | Opus 4.8.
  const cfg = modelConfigFromEnv(env);
  const windowN = chatWindowFromEnv(env);
  const totalMessages = await countMessagesAfter(db, sessionId, null);
  const conversationTurns = Math.floor(totalMessages / 2);
  const opus = await sumOpusSpendSince(db, { userId: user.firebaseUid, sinceISO: startOfUtcDayISO(now) });
  const decision = decideEscalation({
    message,
    hasLinkedEstimate: !!session.enquiryId,
    contradictions: session.contradictions,
    conversationTurns,
    opusSpendTodayUsd: opus.costUsd,
    opusTurnsToday: opus.turns,
    capUsd: opusCapFromEnv(env),
  });

  const bothNull = !models.claudeDefault && !models.claudeOpus;
  if (bothNull) {
    return jsonResponse(503, { error: "model_unconfigured", message: MODEL_UNCONFIGURED_MESSAGE });
  }
  const useOpus = decision.model === "opus" && !!models.claudeOpus;
  const model = useOpus ? models.claudeOpus! : (models.claudeDefault ?? models.claudeOpus!);
  const modelId = useOpus ? cfg.claudeOpus : cfg.claudeDefault;

  // 4. Compose the agent: persona → module fragments/policy → cached digest.
  const services = createAiServices({
    db,
    actor: user.firebaseUid,
    actorRole: user.role,
    sessionId,
  });
  const digest = await getCachedDigest(db);
  const composition = await composeAgent({
    persona: PEBBLE_PERSONA,
    modules: [module02Toolset(services, { sessionId })],
    digestBlock: digest.digestBlock,
    turn: { sessionId, userId: user.firebaseUid, userRole: user.role },
  });

  // 5. Build the ModelMessages: cached system prefix (providerOptions forwarded
  //    verbatim — the digest carries cache breakpoint 1), then the fresh suffix
  //    (summary + session-state + last-N verbatim turns), then the current user
  //    message with cache breakpoint 2 on it.
  const history = await listChatMessages(db, sessionId, windowN);
  const estimateSummary = session.enquiryId
    ? await services.estimateSummaryForEnquiry(session.enquiryId)
    : null;

  const messages: ModelMessage[] = [];
  for (const b of composition.systemBlocks) {
    messages.push(
      b.providerOptions
        ? { role: "system", content: b.content, providerOptions: b.providerOptions }
        : { role: "system", content: b.content },
    );
  }
  if (session.summary && session.summary.trim().length > 0) {
    messages.push({ role: "system", content: `Conversation summary so far: ${session.summary.trim()}` });
  }
  messages.push({
    role: "system",
    content: buildSessionStateBlock({
      slotState: resolveSlotState(session.slotState),
      enquiryId: session.enquiryId,
      estimateSummary,
      contradictions: session.contradictions,
    }),
  });
  for (const m of history) {
    if (!m.content || m.content.trim().length === 0) continue;
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  // Breakpoint 2: cache the whole prefix+suffix so multi-step tool loops read
  // from cache. `@ai-sdk/anthropic` applies message-level cacheControl to the
  // last content block of a string-content user message (verified against the
  // installed provider), so this places the breakpoint on the current turn.
  messages.push({
    role: "user",
    content: message,
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  });

  // 6. Persist the user turn BEFORE streaming.
  await appendChatMessage(db, { sessionId, role: "user", content: message });

  // 7. Stream. streamText is the only author of visible text.
  const result = streamText({
    model,
    messages,
    // The digest system block must live in `messages` (not the `system` option)
    // to carry its cache_control breakpoint; opt into leading system messages.
    allowSystemInMessages: true,
    tools: composition.tools,
    stopWhen: stepCountIs(8),
    onError: (err) => {
      const e = (err as { error?: unknown }).error ?? err;
      console.error("[chat] stream error:", e instanceof Error ? e.message : e);
    },
    onFinish: async ({ text, totalUsage, steps }) => {
      try {
        const parts = reconstructUiParts(steps);
        const toolNames = collectToolNames(steps);
        const content = fullAssistantText(steps, text);

        await appendChatMessage(db, {
          sessionId,
          role: "assistant",
          content,
          lane: "claude",
          model: modelId,
          parts,
        });
        await insertLlmCall(
          db,
          toLlmCallLog({
            lane: "claude",
            model: modelId,
            intent: buildIntentLabel(decision.model, decision.reasons, toolNames),
            inputTokens: usageIn(totalUsage),
            outputTokens: usageOut(totalUsage),
            sessionId,
          }),
        );

        await maybeRefreshSummary(deps, { sessionId, session });
      } catch (err) {
        console.error("[chat] persist onFinish failed:", err instanceof Error ? err.message : err);
      }
    },
  });

  return result.toUIMessageStreamResponse({
    onError: (err) => {
      console.error("[chat] ui stream error:", err instanceof Error ? err.message : err);
      return "The assistant hit an error mid-response. Please try again.";
    },
  });
}

// ─── Summary compaction ──────────────────────────────────────────────────────

/**
 * Refresh the Gemini-Flash running summary when more than the threshold of
 * turns have accumulated since the watermark. Summarises everything after the
 * watermark EXCLUDING the last `PEBBLE_CHAT_WINDOW` messages (those stay
 * verbatim), advances the watermark to the last summarised message, and ledgers
 * the Gemini call. Exported so it is unit-testable without the stream. A no-op
 * (and never throws to the caller) when there is nothing to summarise or no
 * Gemini lane is configured.
 */
export async function maybeRefreshSummary(
  deps: RunAgentTurnDeps,
  args: { sessionId: string; session: ChatSessionRow },
): Promise<void> {
  const { db, models } = deps;
  const env = deps.env ?? process.env;
  const { sessionId, session } = args;
  if (!models.classifier) return;

  const unsummarizedCount = await countMessagesAfter(db, sessionId, session.summaryUptoMessageId);
  if (!shouldRefreshSummary({ unsummarizedCount })) return;

  const windowN = chatWindowFromEnv(env);
  const all = await listChatMessages(db, sessionId, 500);
  const afterWatermark = session.summaryUptoMessageId
    ? all.filter((m) => m.id > session.summaryUptoMessageId!)
    : all;
  const toSummarize = afterWatermark.slice(0, Math.max(0, afterWatermark.length - windowN));
  if (toSummarize.length === 0) return;

  const watermark = toSummarize[toSummarize.length - 1]!.id;
  const cfg = modelConfigFromEnv(env);
  const { summary, usage } = await refreshSummary({
    model: models.classifier,
    oldSummary: session.summary,
    messages: toSummarize.map((m) => ({ role: m.role, content: m.content })),
  });
  await updateSessionSummary(db, sessionId, { summary, uptoMessageId: watermark });
  await insertLlmCall(
    db,
    toLlmCallLog({
      lane: "gemini",
      model: cfg.gemini,
      intent: "summary",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      sessionId,
    }),
  );
}

// ─── Assistant parts + ledger label reconstruction ───────────────────────────

/**
 * Reconstruct the UI-message parts (text + one tool part per tool call) from the
 * finished steps, in order, so a page reload rehydrates the tool-activity rows
 * and receipt cards. Tool parts carry the tool name in their `type`
 * (`tool-<name>`) and progress `input-available` → `output-available` /
 * `output-error`, matching the AI SDK's own UI-message shape.
 */
export function reconstructUiParts(steps: readonly StepResult<ToolSet>[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  const byId = new Map<string, Record<string, unknown>>();

  for (const step of steps) {
    for (const c of step.content) {
      if (c.type === "text") {
        if (c.text.length > 0) parts.push({ type: "text", text: c.text });
      } else if (c.type === "tool-call") {
        const part: Record<string, unknown> = {
          type: `tool-${c.toolName}`,
          toolCallId: c.toolCallId,
          state: "input-available",
          input: c.input,
        };
        byId.set(c.toolCallId, part);
        parts.push(part);
      } else if (c.type === "tool-result") {
        const part = byId.get(c.toolCallId);
        if (part) {
          part.state = "output-available";
          part.output = c.output;
        } else {
          parts.push({
            type: `tool-${c.toolName}`,
            toolCallId: c.toolCallId,
            state: "output-available",
            input: c.input,
            output: c.output,
          });
        }
      } else if (c.type === "tool-error") {
        const part = byId.get(c.toolCallId);
        const errorText = c.error instanceof Error ? c.error.message : String(c.error);
        if (part) {
          part.state = "output-error";
          part.errorText = errorText;
        } else {
          parts.push({
            type: `tool-${c.toolName}`,
            toolCallId: c.toolCallId,
            state: "output-error",
            input: c.input,
            errorText,
          });
        }
      }
    }
  }
  return parts;
}

/** Distinct tool names used across the turn (for the ledger intent label). */
export function collectToolNames(steps: readonly StepResult<ToolSet>[]): string[] {
  const names = new Set<string>();
  for (const step of steps) {
    for (const c of step.content) {
      if (c.type === "tool-call") names.add(c.toolName);
    }
  }
  return [...names];
}

/** The full visible assistant text across all steps (falls back to the final text). */
function fullAssistantText(steps: readonly StepResult<ToolSet>[], finalText: string): string {
  const joined = steps
    .map((s) => s.text)
    .filter((t) => t && t.length > 0)
    .join("\n\n")
    .trim();
  return joined.length > 0 ? joined : finalText;
}

/**
 * The `llm_calls.intent` label for the turn: `agent-opus:<reason>` on an
 * escalation, `agent-suppressed:budget[...]` when an escalation was suppressed
 * by the daily cap, else `agent[<tools>]`. Capped to ~120 chars.
 */
export function buildIntentLabel(
  model: "default" | "opus",
  reasons: string[],
  toolNames: string[],
): string {
  let label: string;
  if (model === "opus") {
    label = `agent-opus:${reasons[0] ?? "escalation"}`;
  } else if (reasons.includes("escalation-suppressed:budget")) {
    label = `agent-suppressed:budget[${toolNames.join(",")}]`;
  } else {
    label = `agent[${toolNames.join(",")}]`;
  }
  return label.slice(0, 120);
}

function usageIn(u: LanguageModelUsage): number {
  return u.inputTokens ?? 0;
}
function usageOut(u: LanguageModelUsage): number {
  return u.outputTokens ?? 0;
}
