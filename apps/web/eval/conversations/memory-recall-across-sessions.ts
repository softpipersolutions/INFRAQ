import { resolveSlotState } from "../../src/server/chat-runtime";
import { getChatSession } from "@pebble/db";
import { allSlotsMissing, type CaseResult, type ConversationScenario, type EvalCtx } from "../harness";

/**
 * Case 12 (WP14) — cross-session memory recall. Session 1 states a durable
 * client preference; whether the model chooses to write it to
 * `/memories` (`packages/ai/src/agent/memory.ts`, the provider-defined
 * `memory_20250818` tool) is genuinely the model's discretion per the
 * persona's MEMORY policy ("write a durable learning back only when it will
 * matter next time") — so a MISSING write is logged, not hard-failed. What IS
 * hard-asserted: no memory tool call ever errors, and — on a BRAND NEW
 * session (fresh sessionId, same user) — a pure recall question produces ZERO
 * slot-state side effects (this is a memory/recall turn, not a capture turn,
 * exactly like `recall-no-side-effects`). When a write DID happen in session
 * 1, session 2's reply must actually reflect it.
 */

const PREFERENCE_MESSAGE =
  "Just a note for next time — we always quote Premium makes for hospital clients, never Standard. Please remember that for future enquiries.";

const RECALL_QUESTION = "What make preference do we use for hospital clients?";

interface MemoryCommandInput {
  command?: string;
}

async function run(ctx: EvalCtx): Promise<CaseResult> {
  const notes: string[] = [];

  // ── Session 1 — state the durable preference. ──────────────────────────
  const session1 = ctx.makeSession();
  const turn1 = await ctx.sendTurn(session1, PREFERENCE_MESSAGE);

  const memoryParts = turn1.parts.filter((p) => p.type === "tool-memory");
  const memoryWriteParts = memoryParts.filter((p) => {
    const input = p.input as MemoryCommandInput | undefined;
    return input?.command === "create" || input?.command === "str_replace";
  });
  const memoryWrote = memoryWriteParts.length > 0;
  const memoryWriteSucceeded =
    memoryWrote &&
    memoryWriteParts.every((p) => p.state === "output-available" && !String(p.output ?? "").startsWith("Error:"));
  notes.push(
    memoryWrote
      ? `session1: memory write occurred (${memoryWriteParts.length} create/str_replace call(s)), succeeded=${memoryWriteSucceeded}`
      : "session1: model chose NOT to write memory for this preference (allowed by the persona's discretion — logged, not a hard fail)",
  );

  const noMemoryError = !memoryParts.some((p) => p.state === "output-error");
  notes.push(noMemoryError ? "no memory tool call errored in session1" : "a memory tool call ERRORED in session1");

  // ── Session 2 — a BRAND NEW session, same user, pure recall question. ──
  const session2 = ctx.makeSession();
  const turn2 = await ctx.sendTurn(session2, RECALL_QUESTION);

  const session2Row = await getChatSession(ctx.db, session2, ctx.user.firebaseUid);
  const state2 = resolveSlotState(session2Row?.slotState ?? null);
  const noSlotSideEffects = allSlotsMissing(state2) && !session2Row?.enquiryId;
  notes.push(
    noSlotSideEffects
      ? "session2: zero slot-state side effects (fresh baseline, no enquiry)"
      : "session2: slot state or enquiry link was TOUCHED by a pure recall question",
  );

  const noCreateCall = !turn2.parts.some((p) => p.type === "tool-create_enquiry");
  notes.push(noCreateCall ? "session2: create_enquiry was not called" : "session2: create_enquiry was called on a pure recall turn");

  const turn2Completed = turn2.response.status === 200;
  notes.push(turn2Completed ? "session2: turn completed without error" : `session2: turn FAILED (status ${turn2.response.status})`);

  // Only assert the recall CONTENT when a write genuinely happened and
  // succeeded — with no write, this is model discretion, not a contract.
  let recallReflectsPreference = true;
  if (memoryWrote && memoryWriteSucceeded) {
    recallReflectsPreference = /premium/i.test(turn2.text);
    notes.push(
      recallReflectsPreference
        ? "session2: reply reflects the stored 'Premium for hospital clients' preference"
        : `session2: reply does NOT mention Premium — "${turn2.text.slice(0, 200)}"`,
    );
  } else {
    notes.push("session2: no successful memory write in session1 — not asserting recall content (model discretion)");
  }

  const pass = noMemoryError && noSlotSideEffects && noCreateCall && turn2Completed && recallReflectsPreference;
  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "memory-recall-across-sessions",
  description:
    "Session 1 states a durable client preference (a memory write is asserted when the model makes one; no write is logged, not hard-failed). A brand-new session 2 recall question has zero slot-state side effects and reflects the stored preference whenever session 1 actually wrote it.",
  run,
};
