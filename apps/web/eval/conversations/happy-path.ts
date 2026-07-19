import { resolveSlotState } from "../../src/server/chat-runtime";
import {
  caseCostUsd,
  checkNoInventedNumbers,
  findEstimateForEnquiry,
  getDigestText,
  getPromptConstantsText,
  type CaseResult,
  type ConversationScenario,
  type EvalCtx,
  type TurnResult,
} from "../harness";
import { getChatSession, getVersionWithLines } from "@pebble/db";

/**
 * Case 1 — happy path: one rich message captures the whole record; Pebble
 * restates and asks for the go-ahead (no enquiry yet); "Yes, go ahead"
 * creates exactly one enquiry + LOCKED v1 estimate. Also the harness's
 * canonical "create a draft" fixture — reused by challenge-escalation and
 * explain-walkthrough.
 */

export const RICH_MESSAGE =
  "New enquiry — client is Sarayu Heritage Hospitality Pvt Ltd, project is Sarayu Riverside Hotel in Ayodhya. " +
  "It's a Commercial building, 6 floors above ground, typical floor area 850 sqm per floor. " +
  "We need FAS, Hydrant and Extinguisher systems — standard makes, and this is a tier 2 project.";

const CANONICAL_SYSTEMS = ["FAS", "Hydrant", "Extinguisher"] as const;

const GO_AHEAD_MESSAGE = "Yes, go ahead.";

export interface DraftFixture {
  sessionId: string;
  enquiryId: string;
  estimateId: string;
  turn1: TurnResult;
  turn2: TurnResult;
}

/**
 * Run the happy-path capture + confirm turns and return the created
 * enquiry/estimate — the reusable fixture other scenarios (challenge,
 * explain) build on. Throws if creation did not actually happen (a hard
 * precondition failure for those scenarios, not a soft assertion).
 */
export async function createDraftViaHappyPath(ctx: EvalCtx): Promise<DraftFixture> {
  const sessionId = ctx.makeSession();
  const turn1 = await ctx.sendTurn(sessionId, RICH_MESSAGE);
  const turn2 = await ctx.sendTurn(sessionId, GO_AHEAD_MESSAGE);

  const session = await getChatSession(ctx.db, sessionId);
  if (!session?.enquiryId) {
    throw new Error(
      `createDraftViaHappyPath: no enquiry linked after the go-ahead turn (reply: ${turn2.text.slice(0, 200)})`,
    );
  }
  const estimate = await findEstimateForEnquiry(ctx.db, session.enquiryId);
  if (!estimate) {
    throw new Error(`createDraftViaHappyPath: enquiry ${session.enquiryId} has no linked estimate`);
  }
  return { sessionId, enquiryId: session.enquiryId, estimateId: estimate.estimateId, turn1, turn2 };
}

async function run(ctx: EvalCtx): Promise<CaseResult> {
  const notes: string[] = [];
  const startedAt = Date.now();
  const sessionId = ctx.makeSession();

  const turn1 = await ctx.sendTurn(sessionId, RICH_MESSAGE);

  const sessionAfter1 = await getChatSession(ctx.db, sessionId);
  const stateAfter1 = resolveSlotState(sessionAfter1?.slotState ?? null);

  const gotSystems = [...((stateAfter1.systemsRequired.value as string[] | null) ?? [])].sort();
  const wantSystems = [...CANONICAL_SYSTEMS].sort();
  const systemsExact = JSON.stringify(gotSystems) === JSON.stringify(wantSystems);
  notes.push(
    systemsExact
      ? `systemsRequired exactly ${wantSystems.join(", ")}`
      : `systemsRequired MISMATCH: got [${gotSystems.join(", ")}] want [${wantSystems.join(", ")}]`,
  );

  const otherFieldsCaptured =
    stateAfter1.clientName.status !== "missing" &&
    stateAfter1.projectName.status !== "missing" &&
    stateAfter1.buildingType.value === "Commercial" &&
    stateAfter1.floorsAbove.value === 6 &&
    stateAfter1.floorAreaSqm.value === 850 &&
    stateAfter1.makePreference.value === "Standard" &&
    stateAfter1.projectTier.value === 2;
  notes.push(otherFieldsCaptured ? "all other required fields extracted" : "some required fields NOT extracted");

  const restatesAndAsks =
    /\?/.test(turn1.text) && /\b(shall I|go ahead|confirm|proceed|create the enquiry|correct)\b/i.test(turn1.text);
  notes.push(restatesAndAsks ? "reply restates + asks to proceed" : "reply did NOT clearly restate + ask");

  const noEnquiryYet = !sessionAfter1?.enquiryId && !turn1.parts.some((p) => p.type === "tool-create_enquiry");
  notes.push(noEnquiryYet ? "no enquiry created before confirmation" : "enquiry created TOO EARLY");

  const turn2 = await ctx.sendTurn(sessionId, GO_AHEAD_MESSAGE);
  const sessionAfter2 = await getChatSession(ctx.db, sessionId);

  const enquiryId = sessionAfter2?.enquiryId ?? null;
  notes.push(enquiryId ? `enquiry created: ${enquiryId}` : "NO enquiry created after go-ahead");
  const turn2Tools = turn2.parts
    .map((p) => p.type)
    .filter((t): t is string => typeof t === "string" && t.startsWith("tool-"));
  notes.push(`turn2 tools called: ${turn2Tools.join(", ") || "(none)"}`);

  const createParts = turn2.parts.filter((p) => p.type === "tool-create_enquiry");
  const exactlyOneCreate = createParts.length === 1;
  const createOutput = createParts[0]?.output as { ok?: boolean; enquiryId?: string; estimateId?: string } | undefined;
  const receiptPresent =
    exactlyOneCreate &&
    createParts[0]?.state === "output-available" &&
    createOutput?.ok === true &&
    Boolean(createOutput.enquiryId) &&
    Boolean(createOutput.estimateId);
  notes.push(
    receiptPresent
      ? `receipt present: ${createOutput?.enquiryId} / ${createOutput?.estimateId}`
      : `receipt NOT present (create_enquiry parts=${createParts.length})`,
  );

  let lockedV1 = false;
  if (enquiryId) {
    const estimate = await findEstimateForEnquiry(ctx.db, enquiryId);
    if (estimate) {
      const version = await getVersionWithLines(ctx.db, estimate.estimateId, 1);
      lockedV1 = version?.version.state === "LOCKED" && version.version.versionNo === 1;
      notes.push(lockedV1 ? `estimate ${estimate.estimateId} is LOCKED v1` : "estimate v1 is NOT locked");
    } else {
      notes.push("no estimate found for the created enquiry");
    }
  }

  // No-invented-numbers: every ₹/decimal/large-whole-number token across both
  // replies must be traceable to a tool output, the user's own words, or the
  // master digest.
  const digestText = await getDigestText(ctx.db);
  const haystacks = [
    JSON.stringify([...turn1.parts, ...turn2.parts]),
    RICH_MESSAGE,
    GO_AHEAD_MESSAGE,
    digestText,
    getPromptConstantsText(),
  ];
  const numberCheck1 = checkNoInventedNumbers(turn1.text, haystacks);
  const numberCheck2 = checkNoInventedNumbers(turn2.text, haystacks);
  const noInventedNumbers = numberCheck1.ok && numberCheck2.ok;
  notes.push(
    noInventedNumbers
      ? `no invented numbers (checked ${numberCheck1.checked.length + numberCheck2.checked.length} tokens)`
      : `INVENTED numbers: turn1=${numberCheck1.invented.join(",")} turn2=${numberCheck2.invented.join(",")}`,
  );

  const costUsd = await caseCostUsd(ctx.db, ctx.user.firebaseUid);
  const wallMs = Date.now() - startedAt;
  const withinCost = costUsd < 0.25;
  const withinWall = wallMs < 90_000;
  notes.push(`cost=$${costUsd.toFixed(4)} (<$0.25 ${withinCost ? "ok" : "FAIL"})`);
  notes.push(`wall=${wallMs}ms (<90000ms ${withinWall ? "ok" : "FAIL"})`);

  const pass =
    systemsExact &&
    otherFieldsCaptured &&
    restatesAndAsks &&
    noEnquiryYet &&
    Boolean(enquiryId) &&
    exactlyOneCreate &&
    receiptPresent &&
    lockedV1 &&
    noInventedNumbers &&
    withinCost &&
    withinWall;

  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "happy-path",
  description:
    "One rich message captures the canonical record; Pebble restates + asks; an explicit yes creates exactly one enquiry + LOCKED v1 estimate with no invented figures.",
  run,
};
