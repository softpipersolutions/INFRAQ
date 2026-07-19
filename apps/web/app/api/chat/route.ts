import {
  applyExtracted,
  buildClassificationPrompt,
  buildExtractionPrompt,
  guardExtractedFields,
  createChatModelsFromEnv,
  extractionSchema,
  INTENTS,
  modelConfigFromEnv,
  routeTurn,
  toLlmCallLog,
  buildPebbleTools,
  type ExtractedFields,
  type IntentClassifier,
} from "@pebble/ai";
import {
  appendChatMessage,
  getOrCreateChatSession,
  insertLlmCall,
  listChatMessages,
  updateSlotState,
} from "@pebble/db";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateObject,
  stepCountIs,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
} from "ai";
import { z } from "zod";
import { createAiServices } from "@/server/ai-services";
import {
  buildSlotResponseText,
  checkDailyBudget,
  COMPUTE_LANE_MESSAGE,
  isSlotFillingInProgress,
  MODEL_UNCONFIGURED_MESSAGE,
  resolveSlotState,
  selectLane,
} from "@/server/chat-runtime";
import { getCachedDigest } from "@/server/digest-cache";
import { getCurrentUser } from "@/server/auth";
import { getDb } from "@/server/db";

/**
 * Conversational chat turn (spec §4.4). Node runtime — PGlite/pg, engines and
 * the AI SDK are node-only. Streaming happens over this plain route handler
 * (tRPC covers the typed control-plane in routers/chat.ts).
 *
 * Deterministic-first: a budget guard and the router resolve the cheapest
 * correct lane; COMPUTE and slot-filling never call Claude; the Claude lane
 * streams a UI-message response the `useChat` client consumes directly, and
 * persists the assistant turn + its cost on finish. Every model call (classify,
 * extract, chat) is logged to llm_calls with its lane/model/usage.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
});

const classificationSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
});

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A UI-message-stream response carrying a single fixed assistant text part. */
function textUiMessageResponse(text: string): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const id = "assistant-text";
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: text });
      writer.write({ type: "text-end", id });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

export async function POST(req: Request): Promise<Response> {
  // 1. Auth.
  const user = await getCurrentUser();
  if (!user) return jsonResponse(401, { error: "Sign in required" });

  // Parse the body.
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return jsonResponse(400, { error: "Body must be { sessionId: string, message: string }" });
  }
  const { sessionId, message } = parsed;

  try {
    const { db } = await getDb();

    // Ensure the session row exists (FK on user).
    const session = await getOrCreateChatSession(db, { sessionId, userId: user.firebaseUid });

    // 2. Daily budget guard (per-user, since UTC midnight).
    const budget = await checkDailyBudget(db, { userId: user.firebaseUid });
    if (budget.blocked) {
      return jsonResponse(429, {
        error: "daily_budget_exceeded",
        message: `Daily AI budget of $${budget.budgetUsd.toFixed(2)} reached (spent $${budget.spentUsd.toFixed(2)}). It resets at UTC midnight.`,
        spentUsd: budget.spentUsd,
        budgetUsd: budget.budgetUsd,
      });
    }

    // 3. Load slot state + recent history (BEFORE appending this user turn).
    const slotState = resolveSlotState(session.slotState);
    const history = await listChatMessages(db, sessionId, 100);
    const slotFilling = isSlotFillingInProgress(slotState);

    // 4. Router (deterministic-first). The classifier is a cheap Gemini enum
    //    call, invoked only on the non-deterministic path; usage is captured for
    //    the ledger. With no Gemini lane configured it defaults conservatively.
    const chatModels = createChatModelsFromEnv(process.env);
    const cfg = modelConfigFromEnv(process.env);
    let classifierUsage: LanguageModelUsage | null = null;
    const classify: IntentClassifier = async (msg) => {
      if (!chatModels.classifier) return { intent: "INTERPRET", confidence: 0 };
      const { object, usage } = await generateObject({
        model: chatModels.classifier,
        schema: classificationSchema,
        prompt: buildClassificationPrompt(msg),
      });
      classifierUsage = usage;
      return object;
    };

    const conversationTurns = history.filter((m) => m.role === "assistant").length;
    const decision = await routeTurn(
      { message, slotFillingInProgress: slotFilling, escalation: { conversationTurns } },
      cfg,
      classify,
    );

    const sel = selectLane(decision, {
      slotFillingInProgress: slotFilling,
      escalation: { conversationTurns },
    });

    // Persist the user turn before dispatching to a lane.
    await appendChatMessage(db, { sessionId, role: "user", content: message });

    // Log the classifier call if it actually ran.
    if (classifierUsage) {
      await insertLlmCall(
        db,
        toLlmCallLog({
          lane: "gemini",
          model: cfg.gemini,
          intent: `classify:${decision.intent}`,
          inputTokens: usageIn(classifierUsage),
          outputTokens: usageOut(classifierUsage),
          sessionId,
        }),
      );
    }

    // ── COMPUTE lane: deterministic, no model. ──────────────────────────────
    if (sel.handler === "compute") {
      await appendChatMessage(db, {
        sessionId,
        role: "assistant",
        content: COMPUTE_LANE_MESSAGE,
        lane: "engine",
      });
      return textUiMessageResponse(COMPUTE_LANE_MESSAGE);
    }

    // ── Slot-filling lane (Gemini extraction + deterministic recap). ────────
    if (sel.handler === "slot") {
      let extracted: ExtractedFields = {};
      if (chatModels.classifier) {
        try {
          const { object, usage } = await generateObject({
            model: chatModels.classifier,
            schema: extractionSchema,
            temperature: 0, // deterministic transcription — no enum "completion"
            prompt: buildExtractionPrompt(message, slotState),
          });
          extracted = guardExtractedFields(object, message);
          await insertLlmCall(
            db,
            toLlmCallLog({
              lane: "gemini",
              model: cfg.gemini,
              intent: "EXTRACT",
              inputTokens: usageIn(usage),
              outputTokens: usageOut(usage),
              sessionId,
            }),
          );
        } catch (err) {
          console.error("[chat] extraction failed:", err instanceof Error ? err.message : err);
        }
      }

      const next = applyExtracted(slotState, extracted);
      await updateSlotState(db, sessionId, next);
      const text = buildSlotResponseText(next);
      await appendChatMessage(db, { sessionId, role: "assistant", content: text, lane: "gemini" });
      return textUiMessageResponse(text);
    }

    // ── Claude lane (INTERPRET / DRAFT_ASSIST / EXPLAIN / LOOKUP / RECALL). ──
    const claudeModel: LanguageModel | null =
      sel.claudeModel === "opus" ? chatModels.claudeOpus : chatModels.claudeDefault;
    if (!claudeModel) {
      // Graceful 503 the UI can render — the structured screens still work.
      return jsonResponse(503, { error: "model_unconfigured", message: MODEL_UNCONFIGURED_MESSAGE });
    }
    const claudeModelId = sel.claudeModel === "opus" ? cfg.claudeOpus : cfg.claudeDefault;

    // System prompt: persona + CACHED master digest (cache_control breakpoint).
    const digest = await getCachedDigest(db);
    const systemMessages: ModelMessage[] = digest.blocks.map((b): ModelMessage =>
      b.providerOptions
        ? { role: "system", content: b.content, providerOptions: b.providerOptions }
        : { role: "system", content: b.content },
    );
    const historyMessages: ModelMessage[] = history.map((m): ModelMessage => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));
    const messages: ModelMessage[] = [
      ...systemMessages,
      ...historyMessages,
      { role: "user", content: message },
    ];

    const services = createAiServices({
      db,
      actor: user.firebaseUid,
      actorRole: user.role,
      sessionId,
    });

    const result = streamText({
      model: claudeModel,
      messages,
      tools: buildPebbleTools(services),
      stopWhen: stepCountIs(5),
      onFinish: async ({ text, totalUsage }) => {
        try {
          await appendChatMessage(db, {
            sessionId,
            role: "assistant",
            content: text,
            lane: "claude",
            model: claudeModelId,
          });
          await insertLlmCall(
            db,
            toLlmCallLog({
              lane: "claude",
              model: claudeModelId,
              intent: sel.intent,
              inputTokens: usageIn(totalUsage),
              outputTokens: usageOut(totalUsage),
              sessionId,
            }),
          );
        } catch (err) {
          console.error("[chat] persist onFinish failed:", err instanceof Error ? err.message : err);
        }
      },
    });

    return result.toUIMessageStreamResponse({
      onError: (err) => {
        console.error("[chat] stream error:", err instanceof Error ? err.message : err);
        return "The assistant hit an error mid-response. Please try again.";
      },
    });
  } catch (err) {
    console.error("[chat] handler error:", err instanceof Error ? err.stack : err);
    return jsonResponse(500, { error: "chat_failed", message: "The chat request could not be processed." });
  }
}

function usageIn(u: LanguageModelUsage): number {
  return u.inputTokens ?? 0;
}
function usageOut(u: LanguageModelUsage): number {
  return u.outputTokens ?? 0;
}
