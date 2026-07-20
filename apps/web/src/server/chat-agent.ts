import "server-only";

import {
  ASK_USER_TOOL_NAME,
  attachmentsToolset,
  buildSessionStateBlock,
  chatWindowFromEnv,
  composeAgent,
  createSkillsLaneFromEnv,
  decideEscalation,
  generateSessionTitle,
  memoryToolset,
  module02Toolset,
  modelConfigFromEnv,
  opusCapFromEnv,
  PEBBLE_PERSONA,
  refreshSummary,
  shouldRefreshSummary,
  skillsLaneEnabled,
  toLlmCallLog,
  type ChatModels,
} from "@pebble/ai";
import {
  appendChatMessage,
  ChatSessionOwnershipError,
  countMessagesAfter,
  getChatAttachment,
  getOrCreateChatSession,
  insertLlmCall,
  listChatMessages,
  setSessionTitle,
  sumOpusSpendSince,
  updateSessionSummary,
  type ChatSessionRow,
  type Db,
} from "@pebble/db";
import { createStorage, type StorageAdapter } from "@pebble/worker";
import {
  hasToolCall,
  smoothStream,
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { createAiServices } from "@/server/ai-services";
import { createAttachmentServices } from "@/server/attachment-services";
import { buildBoundMemoryHandler } from "@/server/memory-services";
import {
  buildAttachmentUserContent,
  checkAttachmentCost,
  toTurnAttachment,
  userFilePartsFor,
  type TurnAttachment,
} from "@/server/chat-attachment-turn";
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
  // The composer's uploaded-attachment ids for this turn (see
  // app/api/chat/attachments). WP8 consumes these: each id is resolved
  // owner-scoped, a pre-flight cost guard refuses an over-budget batch, and the
  // rest are embedded as file/document content on the current user message (and
  // persisted as file parts on the user row). Capped at the composer's own
  // MAX_FILES_PER_REQUEST.
  attachmentIds: z.array(z.string()).max(4).optional(),
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
  /** Storage adapter for reading attachment bytes; defaults to the env-selected one. */
  storage?: StorageAdapter;
}

export interface RunAgentTurnArgs {
  sessionId: string;
  message: string;
  user: { firebaseUid: string; role: string | null };
  /** Uploaded-attachment ids to attach to THIS turn (owner-scoped, cost-guarded). */
  attachmentIds?: string[];
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
  const storage = deps.storage ?? createStorage(env);
  const { sessionId, message, user } = args;
  const attachmentIds = args.attachmentIds ?? [];

  // 1. Ensure the session row exists (slot state + summary + contradictions + link).
  //    Owner-checked BEFORE any streaming: a UUID that already belongs to another
  //    user is rejected (404, not 403 — do not leak that the session exists)
  //    rather than resumed.
  let session: ChatSessionRow;
  try {
    session = await getOrCreateChatSession(db, { sessionId, userId: user.firebaseUid });
  } catch (err) {
    if (err instanceof ChatSessionOwnershipError) {
      return jsonResponse(404, { error: "session_not_found", message: "Session not found." });
    }
    throw err;
  }

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

  // 2b. Resolve the turn's attachments (owner + session scoped) and run the
  //     PRE-FLIGHT COST GUARD before any model call. An unknown/foreign id 404s
  //     with a clean JSON error; an over-budget batch is refused with a friendly
  //     `attachment_too_large` message naming the biggest file (the client's
  //     `friendlyError` renders `.message`). Bytes/text are loaded ONLY after the
  //     metadata-only guard passes, so a huge batch is refused without the IO.
  const attachments: TurnAttachment[] = [];
  if (attachmentIds.length > 0) {
    for (const id of attachmentIds) {
      const row = await getChatAttachment(db, { id, userId: user.firebaseUid });
      if (!row || row.sessionId !== sessionId) {
        return jsonResponse(404, {
          error: "attachment_not_found",
          message: "An attachment for this message could not be found.",
        });
      }
      attachments.push(toTurnAttachment(row));
    }

    const cost = checkAttachmentCost(attachments);
    if (!cost.ok) {
      return jsonResponse(413, { error: "attachment_too_large", message: cost.message });
    }

    await loadAttachmentContent(attachments, storage);
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

  // Second module: the module-agnostic attachments toolset (re-read tools always;
  // the Office analyze/generate tools ONLY when the skills-lane flag is on, so
  // with the flag off they cost nothing — no schema, no prompt). The skills lane
  // is built from env (null when the flag is off / no key), driven by the same
  // model id resolved for this turn.
  const skillsOn = skillsLaneEnabled(env);
  const skillsLane = createSkillsLaneFromEnv(env, { model: modelId });
  const attachmentServices = createAttachmentServices({
    db,
    storage,
    userId: user.firebaseUid,
    skillsLane,
  });
  // Third module: the agent-core cross-session memory toolset (WP9). Composed on
  // EVERY turn like ask_user — its execute handler is bound to the authenticated
  // userId + db, so the Claude memory tool can only ever touch this user's own
  // /memories store (path-safe + capped in the handler). The SDK auto-attaches
  // the memory beta header when this provider-defined tool is present.
  const memoryHandler = buildBoundMemoryHandler(db, user.firebaseUid);
  const composition = await composeAgent({
    persona: PEBBLE_PERSONA,
    modules: [
      module02Toolset(services, { sessionId }),
      attachmentsToolset(attachmentServices, { sessionId, skillsEnabled: skillsOn }),
      memoryToolset(memoryHandler),
    ],
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
  // Build the current user message content from the typed text + resolved
  // attachments: text/csv/md become fenced blocks, PDFs/images become file
  // content parts, and OFFICE_PENDING files surface as a fresh system note
  // (never cached) placed just before the user message.
  const built = buildAttachmentUserContent({ text: message, attachments, skillsEnabled: skillsOn });
  if (built.officeNote) {
    messages.push({ role: "system", content: built.officeNote });
  }
  // Breakpoint 2: cache the whole prefix+suffix so multi-step tool loops read
  // from cache. `@ai-sdk/anthropic` lands message-level cacheControl on the LAST
  // content block of a user message — whether that content is a plain string
  // (no attachments) or a multi-part array (attachments last), so the breakpoint
  // always sits on the final block of the current turn.
  messages.push({
    role: "user",
    content: built.content,
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  });

  // 6. Persist the user turn BEFORE streaming. When files are attached, persist
  //    their file parts on the user row so a reload rehydrates the chips (the
  //    history→UI mapper renders `{type:'file', attachmentId, …}` as static
  //    chips; legacy text-only rows still have `parts: null`).
  const userParts = userFilePartsFor(attachments);
  await appendChatMessage(db, {
    sessionId,
    role: "user",
    content: message,
    parts: userParts.length > 0 ? userParts : null,
  });

  // 7. Stream. streamText is the only author of visible text.
  const result = streamText({
    model,
    messages,
    // The digest system block must live in `messages` (not the `system` option)
    // to carry its cache_control breakpoint; opt into leading system messages.
    allowSystemInMessages: true,
    tools: composition.tools,
    // Stop at 8 steps, OR the moment the agent asks a structured clarification:
    // `ask_user` has no executor, so the SDK cannot feed a result back and the
    // loop ends there anyway — this `hasToolCall` guard makes that a stated
    // contract (belt-and-braces against a future SDK that would keep looping),
    // so the turn always ends AT the question with the option chips on screen.
    stopWhen: [stepCountIs(8), hasToolCall(ASK_USER_TOOL_NAME)],
    // WP5 streaming feel: re-chunk the model's raw text deltas into
    // word-sized pieces on a short internal delay so the UI receives a
    // steady drip instead of large, bursty deltas. Purely a client-perceived
    // pacing change — it does not alter the UI-message-stream's event
    // semantics (still text-start/text-delta/tool-*), only how finely the
    // text-delta payloads are sliced, so the eval harness is unaffected.
    experimental_transform: smoothStream({ chunking: "word" }),
    onError: (err) => {
      const e = (err as { error?: unknown }).error ?? err;
      console.error("[chat] stream error:", e instanceof Error ? e.message : e);
    },
    onFinish: async ({ text, totalUsage, steps, providerMetadata }) => {
      try {
        const parts = reconstructUiParts(steps);
        const toolNames = collectToolNames(steps);
        // Persist the question INTO the assistant content text (never streamed
        // to the client) so the model — whose next turn's history is rebuilt
        // from content text — sees the clarification it just asked.
        const content = appendAskUserSuffix(fullAssistantText(steps, text), steps);

        await appendChatMessage(db, {
          sessionId,
          role: "assistant",
          content,
          lane: "claude",
          model: modelId,
          parts,
        });
        // Cache reads/writes bill at their own rates and would otherwise be
        // invisible to the ledger: `totalUsage.cachedInputTokens` carries the
        // reads; writes come from Anthropic's provider metadata. Sum writes
        // across steps (each step of a tool loop may write). `toLlmCallLog`
        // both prices these into costUsd AND surfaces the two raw counts, which
        // `insertLlmCall` writes to llm_calls.cache_read_tokens/cache_write_tokens.
        const anthropicUsage = (providerMetadata?.anthropic as
          | { usage?: { cache_creation_input_tokens?: number } }
          | undefined)?.usage;
        const stepWrites = steps.reduce((sum, s) => {
          const su = (s.providerMetadata?.anthropic as
            | { usage?: { cache_creation_input_tokens?: number } }
            | undefined)?.usage;
          return sum + (su?.cache_creation_input_tokens ?? 0);
        }, 0);
        await insertLlmCall(
          db,
          toLlmCallLog({
            lane: "claude",
            model: modelId,
            intent: buildIntentLabel(decision.model, decision.reasons, toolNames),
            inputTokens: usageIn(totalUsage),
            outputTokens: usageOut(totalUsage),
            sessionId,
            cache: {
              cacheReadTokens: totalUsage.cachedInputTokens ?? 0,
              cacheWriteTokens: stepWrites || (anthropicUsage?.cache_creation_input_tokens ?? 0),
            },
          }),
        );

        await maybeRefreshSummary(deps, { sessionId, session });

        // Auto-title (fire-and-forget): mint a short session-list label from the
        // first exchange via Gemini Flash. Deliberately NOT awaited — onFinish
        // has already persisted everything the UI needs, and a slow/failed
        // title call must never hold up the response or (via the outer catch)
        // ever be mistaken for a persistence failure. `.catch` swallows so an
        // unhandled rejection can't surface elsewhere.
        void maybeGenerateTitle(deps, {
          sessionId,
          session,
          userText: message,
          assistantText: content,
        }).catch((err) => {
          console.error("[chat] auto-title failed:", err instanceof Error ? err.message : err);
        });
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
  await updateSessionSummary(db, sessionId, session.userId, { summary, uptoMessageId: watermark });
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

// ─── Auto-title ───────────────────────────────────────────────────────────────

/**
 * Mint a session-list title from the first exchange via Gemini Flash
 * (`@pebble/ai`'s `generateSessionTitle`) and persist it. Exported so it is
 * unit-testable without the stream, mirroring `maybeRefreshSummary`. A no-op
 * — and never throws to the caller — when:
 *   - the session already has a title (a user rename OR an earlier auto-title
 *     — `session.title` was read at the START of this turn, so a rename that
 *     landed mid-turn is still caught by `setSessionTitle`'s own `title IS
 *     NULL` guard even if this check raced past it);
 *   - more than the first exchange has landed (`countMessagesAfter` counts
 *     the user+assistant messages THIS turn just persisted, so a fresh
 *     session's total is exactly 2 here — later turns see a higher count and
 *     skip);
 *   - no Gemini lane is configured, or the model declines to produce a usable
 *     title (`generateSessionTitle` itself never throws — see `@pebble/ai`).
 */
export async function maybeGenerateTitle(
  deps: RunAgentTurnDeps,
  args: { sessionId: string; session: ChatSessionRow; userText: string; assistantText: string },
): Promise<void> {
  const { db, models } = deps;
  const { sessionId, session, userText, assistantText } = args;
  if (session.title) return;
  if (!models.classifier) return;

  const totalMessages = await countMessagesAfter(db, sessionId, null);
  if (totalMessages > 2) return;

  const generated = await generateSessionTitle({ model: models.classifier, userText, assistantText });
  if (!generated) return;

  await setSessionTitle(db, { sessionId, userId: session.userId, title: generated.title });
  const cfg = modelConfigFromEnv(deps.env ?? process.env);
  await insertLlmCall(
    db,
    toLlmCallLog({
      lane: "gemini",
      model: cfg.gemini,
      intent: "title",
      inputTokens: generated.usage.inputTokens,
      outputTokens: generated.usage.outputTokens,
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
 * When the finished turn asked a structured clarification (an `ask_user` call),
 * append a compact record of it to the PERSISTED content text:
 *   `[Asked: <question> — options: <label1> | <label2> ...]`
 * so the model — whose next turn's history is rebuilt from content text, not
 * parts — sees its own question and the options it offered. This is
 * persistence-only: it is NEVER streamed to the client (the client renders the
 * clarification card from the `tool-ask_user` part instead). Only the first
 * `ask_user` call is recorded (the persona/policy allow at most one per turn).
 */
export function appendAskUserSuffix(content: string, steps: readonly StepResult<ToolSet>[]): string {
  for (const step of steps) {
    for (const c of step.content) {
      if (c.type !== "tool-call" || c.toolName !== ASK_USER_TOOL_NAME) continue;
      const input = c.input as { question?: unknown; options?: unknown } | null | undefined;
      const question = typeof input?.question === "string" ? input.question.trim() : "";
      const options = Array.isArray(input?.options) ? input.options : [];
      const labels = options
        .map((o) => (o && typeof (o as { label?: unknown }).label === "string" ? (o as { label: string }).label : null))
        .filter((l): l is string => !!l && l.length > 0);
      if (!question || labels.length === 0) return content;
      const suffix = `[Asked: ${question} — options: ${labels.join(" | ")}]`;
      return content.length > 0 ? `${content}\n\n${suffix}` : suffix;
    }
  }
  return content;
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

/**
 * Load each attachment's content for embedding on the message: raw bytes for
 * PDFs/images (attached as file/document blocks), decoded UTF-8 text for
 * text/csv/md (appended as fenced blocks). Office/other files are never
 * embedded, so they are skipped (the model reaches them via the re-read/analyze
 * tools). A storage read failure leaves that attachment's content unset — the
 * message still assembles, just without that file's bytes/text.
 */
async function loadAttachmentContent(
  attachments: TurnAttachment[],
  storage: StorageAdapter,
): Promise<void> {
  await Promise.all(
    attachments.map(async (a) => {
      if (a.kind !== "pdf" && a.kind !== "image" && a.kind !== "text") return;
      if (!a.storageUri) return;
      let bytes: Uint8Array;
      try {
        bytes = await storage.get(a.storageUri);
      } catch (err) {
        console.error("[chat] attachment read failed:", a.id, err instanceof Error ? err.message : err);
        return;
      }
      if (a.kind === "text") {
        a.text = new TextDecoder("utf-8").decode(bytes);
      } else {
        a.bytes = bytes;
      }
    }),
  );
}
