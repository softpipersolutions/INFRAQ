import { resolveSlotState } from "../../src/server/chat-runtime";
import { getChatSession } from "@pebble/db";
import { allSlotsMissing, seedPastEstimateChunk, type CaseResult, type ConversationScenario, type EvalCtx } from "../harness";

/**
 * Case 5 — recall, no side effects. A fresh session's very first message is a
 * pure recall question — nothing about a new enquiry. The agent should search
 * (RAG), cite what it finds, and touch NOTHING else: the slot state stays the
 * fresh-session baseline (every field missing) and no enquiry is created.
 */

const RECALL_QUESTION = "What did we quote for the Ayodhya hotel job before?";

async function run(ctx: EvalCtx): Promise<CaseResult> {
  const notes: string[] = [];
  const sessionId = ctx.makeSession();

  await seedPastEstimateChunk(ctx.db, {
    filename: "Ayodhya Grand Hotel - FAS Proposal.pdf",
    content: "Ayodhya Grand Hotel — Fire Alarm System proposal, 45 smoke detectors, prior Greenberg engagement.",
  });

  const turn = await ctx.sendTurn(sessionId, RECALL_QUESTION);
  const session = await getChatSession(ctx.db, sessionId);
  const state = resolveSlotState(session?.slotState ?? null);

  const searchUsed = turn.parts.some((p) => p.type === "tool-search_past_estimates");
  notes.push(searchUsed ? "search_past_estimates tool part present" : "search_past_estimates NOT called");

  const stateStillMissing = allSlotsMissing(state);
  notes.push(stateStillMissing ? "slot state remains fully missing" : "slot state was TOUCHED by a pure recall turn");

  const noEnquiry = !session?.enquiryId;
  notes.push(noEnquiry ? "no enquiry created" : `enquiry UNEXPECTEDLY created: ${session?.enquiryId}`);

  const noCreateCall = !turn.parts.some((p) => p.type === "tool-create_enquiry");
  notes.push(noCreateCall ? "create_enquiry was not called" : "create_enquiry was called on a pure recall turn");

  const pass = searchUsed && stateStillMissing && noEnquiry && noCreateCall;
  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "recall-no-side-effects",
  description:
    "A fresh session's first message is a pure recall question: search is used, but slot state stays fully missing and no enquiry is created.",
  run,
};
