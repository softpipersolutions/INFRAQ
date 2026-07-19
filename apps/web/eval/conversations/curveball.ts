import { resolveSlotState } from "../../src/server/chat-runtime";
import { getChatSession } from "@pebble/db";
import { capturedFieldCount, seedPastEstimateChunk, type CaseResult, type ConversationScenario, type EvalCtx } from "../harness";

/**
 * Case 3 — curveball: a topic change mid-capture. The user asks a recall
 * question in the middle of giving enquiry details; the agent should search
 * (not silently ignore it, not fold it into capture), leave the slot state
 * exactly as it was, and then resume capture cleanly on the next turn.
 */

const TURN_1 = "New enquiry: client Sarayu Heritage Hospitality Pvt Ltd, project Sarayu Riverside Hotel, Commercial building, Ayodhya.";
const CURVEBALL = "Actually, quick one first — what did we quote for the Ayodhya hotel before?";
const RESUME = "OK, back to this one: 6 floors above ground, 850 sqm per floor, FAS and Hydrant, standard makes, tier 2.";

async function run(ctx: EvalCtx): Promise<CaseResult> {
  const notes: string[] = [];
  const sessionId = ctx.makeSession();

  await seedPastEstimateChunk(ctx.db, {
    filename: "Ayodhya Grand Hotel - FAS Proposal.pdf",
    content:
      "Ayodhya Grand Hotel — Fire Alarm System proposal: 45 photoelectric smoke detectors, manual call points, total SITC value quoted at prior engagement.",
  });

  await ctx.sendTurn(sessionId, TURN_1);
  const beforeState = resolveSlotState((await getChatSession(ctx.db, sessionId))?.slotState ?? null);
  const beforeCount = capturedFieldCount(beforeState);

  const curveballTurn = await ctx.sendTurn(sessionId, CURVEBALL);
  const afterCurveballSession = await getChatSession(ctx.db, sessionId);
  const afterCurveballState = resolveSlotState(afterCurveballSession?.slotState ?? null);

  const searchUsed = curveballTurn.parts.some((p) => p.type === "tool-search_past_estimates");
  notes.push(searchUsed ? "search_past_estimates tool part present" : "search_past_estimates NOT called");

  const stateUnchanged = JSON.stringify(afterCurveballState) === JSON.stringify(beforeState);
  notes.push(stateUnchanged ? "slot state unchanged by the curveball turn" : "slot state CHANGED by the curveball turn");

  const resumeTurn = await ctx.sendTurn(sessionId, RESUME);
  const afterResumeState = resolveSlotState((await getChatSession(ctx.db, sessionId))?.slotState ?? null);
  const afterResumeCount = capturedFieldCount(afterResumeState);

  const captureResumed = afterResumeCount > beforeCount;
  notes.push(
    captureResumed
      ? `capture resumed (${beforeCount} -> ${afterResumeCount} captured fields)`
      : `capture did NOT grow (${beforeCount} -> ${afterResumeCount})`,
  );
  notes.push(`resume reply length=${resumeTurn.text.length}`);

  const pass = searchUsed && stateUnchanged && captureResumed;
  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "curveball",
  description:
    "Mid-capture recall question ('what did we quote for the Ayodhya hotel?') triggers search_past_estimates without touching slot state; capture resumes intact on the next turn.",
  run,
};
