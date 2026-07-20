import { applyExtracted, confirmAllProposed, initSlotState, type SlotState } from "@pebble/ai";
import { getChatSession, getOrCreateChatSession, updateSlotState } from "@pebble/db";
import type { CaseResult, ConversationScenario, EvalCtx } from "../harness";

/**
 * Case 6 — self-heal from a corrupted legacy slot_state. Seeds the exact
 * historical bug: `systemsRequired` padded with the internal-only `"Common"`
 * system type (valid in the DB's `SYSTEM_TYPES` enum, but explicitly excluded
 * from `REQUESTABLE_SYSTEM_TYPES` / the chat extractor — see
 * `packages/shared/src/enums.ts`), left `proposed` (never confirmed). Asking
 * to create the enquiry should hit `buildEnquiryInput`'s validation refusal,
 * and the persona's self-heal script (get_enquiry_state -> repair_enquiry_state)
 * should diagnose and fix it. Tolerant per spec: pass on EITHER a full
 * repair+create, OR a clear diagnosis with a repair attempt (no crash).
 */

function corruptLegacyState(): SlotState {
  const base = applyExtracted(initSlotState(), {
    clientName: "Sarayu Heritage Hospitality Pvt Ltd",
    projectName: "Sarayu Riverside Hotel",
    buildingType: "Commercial",
    floorsAbove: 5,
    floorAreaSqm: 700,
    makePreference: "Standard",
    projectTier: 2,
  });
  const confirmed = confirmAllProposed(base);
  // The old padded-systems bug: an internal "Common" value leaked into a
  // client-requested-systems slot, left proposed (never confirmed).
  return { ...confirmed, systemsRequired: { status: "proposed", value: ["FAS", "Common", "Hydrant"] } };
}

const FIRST_ASK = "Please create the enquiry.";
const FOLLOW_UP = "Please fix whatever is wrong and go ahead and create the enquiry.";

async function run(ctx: EvalCtx): Promise<CaseResult> {
  const notes: string[] = [];
  const sessionId = ctx.makeSession();
  await getOrCreateChatSession(ctx.db, { sessionId, userId: ctx.user.firebaseUid });
  await updateSlotState(ctx.db, sessionId, ctx.user.firebaseUid, corruptLegacyState());

  const turn1 = await ctx.sendTurn(sessionId, FIRST_ASK);
  const noCrash1 = turn1.response.status === 200 && turn1.text.trim().length > 0;
  notes.push(noCrash1 ? "turn 1: no crash, got a reply" : `turn 1 CRASHED or empty (status ${turn1.response.status})`);

  let session = await getChatSession(ctx.db, sessionId, ctx.user.firebaseUid);
  let createdWithValidSystems =
    Boolean(session?.enquiryId) &&
    !((session?.slotState as { systemsRequired?: { value?: unknown[] } } | null)?.systemsRequired?.value ?? []).includes(
      "Common",
    );

  const diagnosedTurn1 = turn1.parts.some(
    (p) => p.type === "tool-get_enquiry_state" || p.type === "tool-repair_enquiry_state",
  );

  let turn2Ran = false;
  let noCrash2 = true;
  let diagnosedTurn2 = false;
  if (!createdWithValidSystems && !session?.enquiryId) {
    // Give it one follow-up turn to complete the self-heal, per spec ("after a
    // follow-up confirm the enquiry EXISTS with valid systems").
    const turn2 = await ctx.sendTurn(sessionId, FOLLOW_UP);
    turn2Ran = true;
    noCrash2 = turn2.response.status === 200 && turn2.text.trim().length > 0;
    diagnosedTurn2 = turn2.parts.some(
      (p) => p.type === "tool-get_enquiry_state" || p.type === "tool-repair_enquiry_state",
    );
    session = await getChatSession(ctx.db, sessionId, ctx.user.firebaseUid);
    createdWithValidSystems =
      Boolean(session?.enquiryId) &&
      !((session?.slotState as { systemsRequired?: { value?: unknown[] } } | null)?.systemsRequired?.value ?? []).includes(
        "Common",
      );
    notes.push(noCrash2 ? "turn 2: no crash, got a reply" : `turn 2 CRASHED or empty (status ${turn2.response.status})`);
  }

  const diagnosed = diagnosedTurn1 || diagnosedTurn2;
  notes.push(diagnosed ? "get_enquiry_state / repair_enquiry_state tool part(s) present" : "NO diagnosis tool part seen");
  notes.push(
    createdWithValidSystems
      ? `repaired + created: enquiry ${session?.enquiryId}`
      : "not (yet) repaired + created — checking the tolerant fallback",
  );
  notes.push(`turn2 attempted: ${turn2Ran}`);

  // Tolerant per spec: EITHER fully repaired + created, OR clearly diagnosed
  // (a repair attempt was made) with no crash anywhere.
  const pass = noCrash1 && noCrash2 && (createdWithValidSystems || diagnosed);
  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "self-heal",
  description:
    "A session seeded with the legacy padded-systems bug (systemsRequired containing the internal-only 'Common' value) is diagnosed and repaired rather than crashing.",
  run,
};
