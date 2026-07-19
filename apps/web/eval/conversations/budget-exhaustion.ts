import { getOrCreateChatSession } from "@pebble/db";
import { caseCostUsd, seedLlmSpend, type CaseResult, type ConversationScenario, type EvalCtx } from "../harness";

/**
 * Case 7 — budget exhaustion. Seeds llm_calls spend for the user's account
 * past the $5/day default (`PEBBLE_DAILY_LLM_BUDGET_USD`,
 * `chat-runtime.ts#checkDailyBudget`) on one session, then sends a turn on a
 * BRAND NEW session for the same user — the guard is per-user, not
 * per-session. Expects a friendly 429 JSON body and, critically, no new
 * llm_calls row (the guard fires before any model call).
 */

const SEED_COST_USD = 5.5; // > the $5 default daily budget
const MESSAGE = "Hi, I'd like to start a new enquiry.";

async function run(ctx: EvalCtx): Promise<CaseResult> {
  const notes: string[] = [];
  const seedSessionId = ctx.makeSession();
  await getOrCreateChatSession(ctx.db, { sessionId: seedSessionId, userId: ctx.user.firebaseUid });
  await seedLlmSpend(ctx.db, { sessionId: seedSessionId, costUsd: SEED_COST_USD });

  const costBefore = await caseCostUsd(ctx.db, ctx.user.firebaseUid);
  notes.push(`seeded spend: $${costBefore.toFixed(2)}`);

  const freshSessionId = ctx.makeSession();
  const turn = await ctx.sendTurn(freshSessionId, MESSAGE);

  const is429 = turn.response.status === 429;
  notes.push(is429 ? "status 429" : `status ${turn.response.status} (want 429)`);

  let friendlyJson = false;
  try {
    const parsed = JSON.parse(await turn.response.clone().text()) as { error?: string; message?: string };
    friendlyJson = parsed.error === "daily_budget_exceeded" && typeof parsed.message === "string" && parsed.message.length > 0;
  } catch {
    friendlyJson = false;
  }
  notes.push(friendlyJson ? "friendly JSON body (daily_budget_exceeded + message)" : "body is NOT the expected friendly JSON");

  const costAfter = await caseCostUsd(ctx.db, ctx.user.firebaseUid);
  const noNewCall = costAfter === costBefore;
  notes.push(noNewCall ? `no new llm_calls row (cost unchanged at $${costAfter.toFixed(2)})` : `cost CHANGED: $${costBefore.toFixed(2)} -> $${costAfter.toFixed(2)}`);

  const pass = is429 && friendlyJson && noNewCall;
  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "budget-exhaustion",
  description:
    "Past the $5/day per-user budget, a turn on a brand new session returns a friendly 429 and inserts no new llm_calls row.",
  run,
};
