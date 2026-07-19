import { resolveSlotState } from "../../src/server/chat-runtime";
import { getChatSession } from "@pebble/db";
import type { CaseResult, ConversationScenario, EvalCtx } from "../harness";

/**
 * Case 2 — incremental intake + a mid-stream correction. Three short turns
 * build the record piece by piece (all values land as PROPOSED, never
 * confirmed), then "actually 6 floors not 8" corrects a still-proposed field.
 * Correcting a PROPOSED value is explicitly NOT a contradiction (only a
 * CONFIRMED slot changing counts — `detectConfirmedOverwrite` in
 * `packages/ai/src/slots.ts`), so the persisted counter must stay 0.
 */

const TURN_1 = "New enquiry: client Meridian Textiles Ltd, project Meridian Warehouse Phase 2, Industrial building.";
const TURN_2 = "8 floors above ground, typical floor area 1200 sqm per floor.";
const TURN_3 = "We need FAS and Sprinkler, standard makes, tier 3.";
const TURN_4 = "Actually, 6 floors, not 8.";

async function run(ctx: EvalCtx): Promise<CaseResult> {
  const notes: string[] = [];
  const sessionId = ctx.makeSession();

  await ctx.sendTurn(sessionId, TURN_1);
  await ctx.sendTurn(sessionId, TURN_2);
  await ctx.sendTurn(sessionId, TURN_3);
  const turn4 = await ctx.sendTurn(sessionId, TURN_4);

  const session = await getChatSession(ctx.db, sessionId);
  const state = resolveSlotState(session?.slotState ?? null);

  const correctedFloors = state.floorsAbove.value === 6;
  notes.push(correctedFloors ? "floorsAbove corrected to 6" : `floorsAbove is ${String(state.floorsAbove.value)} (want 6)`);

  const mentionsCorrection = /\b6\b/.test(turn4.text) && /floor/i.test(turn4.text);
  notes.push(mentionsCorrection ? "reply mentions the correction" : "reply does NOT clearly mention the correction");

  // Soft heuristic per spec: the reply should not re-ask for already-captured
  // fields (e.g. client) just because a correction came in.
  const doesNotReask = !/\bclient\b/i.test(turn4.text);
  notes.push(doesNotReask ? "reply does not re-ask for client" : "reply appears to RE-ASK for client");

  const contradictionsStayZero = (session?.contradictions ?? -1) === 0;
  notes.push(
    contradictionsStayZero
      ? "contradiction counter stayed 0 (correcting a PROPOSED value is not a contradiction)"
      : `contradiction counter is ${session?.contradictions} (want 0)`,
  );

  const pass = correctedFloors && mentionsCorrection && doesNotReask && contradictionsStayZero;
  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "incremental-correction",
  description:
    "Three short capture turns then a mid-stream correction ('6 floors not 8'): the state updates, the reply doesn't re-ask captured fields, and the contradiction counter stays 0 (a proposed-value correction is not a contradiction).",
  run,
};
