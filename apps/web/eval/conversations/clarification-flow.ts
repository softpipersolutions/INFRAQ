import { resolveSlotState } from "../../src/server/chat-runtime";
import { getChatSession } from "@pebble/db";
import { capturedFieldCount, type CaseResult, type ConversationScenario, type EvalCtx } from "../harness";

/**
 * Case 9 (WP14) — clarification flow. An ambiguous opener leaves TWO fields
 * genuinely open ("systems and tier are still TBD — you pick what to ask")
 * instead of guessing or inventing values. The persona's contract
 * (`packages/ai/src/agent/ask-user.ts`, `agent/persona.ts`) is: at most one
 * `ask_user` call per turn, 2–4 concrete option chips, and — because the tool
 * has NO executor — the SDK cannot feed a result back in, so the turn ends AT
 * the question. We must NOT await an `output-available` for it (there isn't
 * one): the part should stay at `input-available` forever. Tapping one
 * option's own label text on the following turn should then let capture
 * proceed (no re-explaining, no dead end).
 */

const OPENING_MESSAGE =
  "Need fire safety cover for our building — client is Meridian Watch Co, project Meridian Depot, an Industrial " +
  "building in Nashik, 4 floors above ground, 600 sqm typical floor plate. Systems and tier are still TBD — you " +
  "pick what to ask me first, one thing at a time.";

interface AskUserInput {
  question: string;
  options: Array<{ label: string; detail?: string }>;
  allowFreeText: boolean;
}

async function run(ctx: EvalCtx): Promise<CaseResult> {
  const notes: string[] = [];
  const sessionId = ctx.makeSession();

  const turn1 = await ctx.sendTurn(sessionId, OPENING_MESSAGE);

  const askParts = turn1.parts.filter((p) => p.type === "tool-ask_user");
  const askPart = askParts[0];
  const askInput = askPart?.input as AskUserInput | undefined;
  const hasAsk = askParts.length >= 1 && Boolean(askInput);
  notes.push(hasAsk ? "tool-ask_user part present" : "NO tool-ask_user part found — did NOT trigger a clarification");

  // ask_user has NO executor by design — its call ends the turn at
  // input-available; there is deliberately never an output-available to wait
  // for (see the tool's own doc comment). Assert it STAYED that way.
  const neverResolved = askParts.every((p) => p.state === "input-available" && p.output === undefined);
  notes.push(
    neverResolved
      ? "ask_user part stayed at input-available with no output (no executor, as designed)"
      : "ask_user part unexpectedly carries an output — it should have no executor",
  );

  const optionCount = askInput?.options?.length ?? 0;
  const optionCountOk = optionCount >= 2 && optionCount <= 4;
  notes.push(
    optionCountOk
      ? `ask_user offered ${optionCount} options`
      : `ask_user offered ${optionCount} options (want 2-4 per the tool's schema)`,
  );

  // The turn ended AT the question: ask_user is structurally the LAST part
  // (no executor means the SDK's multi-step loop cannot continue past it —
  // `stopWhen: [stepCountIs(8), hasToolCall(ASK_USER_TOOL_NAME)]` in
  // chat-agent.ts is belt-and-braces for exactly this).
  const endsAtAskUser = hasAsk && turn1.parts[turn1.parts.length - 1]?.type === "tool-ask_user";
  notes.push(endsAtAskUser ? "ask_user is the last part — the turn ended there" : "a part followed ask_user — the turn did NOT end at the question");

  const sessionAfter1 = await getChatSession(ctx.db, sessionId, ctx.user.firebaseUid);
  const noEnquiryYet = !sessionAfter1?.enquiryId && !turn1.parts.some((p) => p.type === "tool-create_enquiry");
  notes.push(
    noEnquiryYet
      ? "no enquiry created before the clarification is answered"
      : "enquiry created TOO EARLY, before the clarification was answered",
  );

  const stateAfter1 = resolveSlotState(sessionAfter1?.slotState ?? null);
  const countAfter1 = capturedFieldCount(stateAfter1);
  notes.push(`captured fields after turn1 (pre-answer): ${countAfter1}`);

  const pass1 = hasAsk && neverResolved && optionCountOk && endsAtAskUser && noEnquiryYet;

  if (!hasAsk || !askInput || optionCount === 0) {
    // Nothing to answer — report what we have and stop (a genuine model miss
    // on this turn, not a harness bug).
    return { pass: pass1, notes };
  }

  // Answer with one option's OWN label text — exactly what a tapped chip sends.
  const chosenLabel = askInput.options[0]!.label;
  const turn2 = await ctx.sendTurn(sessionId, chosenLabel);

  const sessionAfter2 = await getChatSession(ctx.db, sessionId, ctx.user.firebaseUid);
  const stateAfter2 = resolveSlotState(sessionAfter2?.slotState ?? null);
  const countAfter2 = capturedFieldCount(stateAfter2);
  const captureProceeded = countAfter2 > countAfter1;
  notes.push(
    captureProceeded
      ? `answering the chip grew capture (${countAfter1} -> ${countAfter2} captured fields)`
      : `capture did NOT grow after answering the chip (${countAfter1} -> ${countAfter2})`,
  );
  notes.push(`turn2 reply length=${turn2.text.length}`);

  const pass = pass1 && captureProceeded;
  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "clarification-flow",
  description:
    "An ambiguous opener (systems + tier left TBD) triggers ask_user with 2-4 option chips and ends the turn there (no create_enquiry, no invented values, no output-available on the ask_user part); tapping one option's own label lets capture proceed.",
  run,
};
