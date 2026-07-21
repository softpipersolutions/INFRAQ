import { TRPCError } from "@trpc/server";
import { getChatSession, upsertUser, type AppUser } from "@pebble/db";
import { resolveSlotState } from "../../src/server/chat-runtime";
import { runAgentTurn } from "../../src/server/chat-agent";
import { appRouter } from "../../src/server/routers/_app";
import { createCallerFactory } from "../../src/server/trpc";
import {
  allSlotsMissing,
  consumeUiMessageStream,
  type CaseResult,
  type ConversationScenario,
  type EvalCtx,
  type TurnResult,
} from "../harness";
import { createDraftViaHappyPath } from "./happy-path";

/**
 * Case 13 (WP14) — multi-session / multi-user isolation. User A (the
 * harness's own dev user) gets a REAL confirmed draft via the happy-path
 * fixture — concrete client/project values and a real enquiry/estimate id to
 * leak if isolation is broken. A second, distinct user (a fresh
 * `firebaseUid`, upserted directly the way `chat-router.test.ts` seeds its
 * `OTHER` fixture) then asks about "my current enquiry draft" on their OWN
 * brand-new session. Three things must all hold: user B's reply names none of
 * user A's values, user B's own session state stays the untouched baseline,
 * and reaching for user A's session BY ID directly through the router (the
 * same `createCaller` pattern `chat-router.test.ts` uses) is NOT_FOUND — never
 * FORBIDDEN, which would leak that the session exists at all.
 */

const createCaller = createCallerFactory(appRouter);

const USER_B: AppUser = {
  firebaseUid: "eval-isolation-user-b",
  email: "eval-isolation-b@greenberg.test",
  displayName: "Eval Isolation User B",
  role: "estimator",
  active: true,
};

const B_QUESTION = "What's in my current enquiry draft? Please recap it for me.";

/** Send one turn as an arbitrary user (bypassing `ctx.sendTurn`, which is bound to the harness's own dev user). */
async function sendTurnAsUser(
  ctx: EvalCtx,
  user: Pick<AppUser, "firebaseUid" | "role">,
  sessionId: string,
  message: string,
): Promise<TurnResult> {
  const response = await runAgentTurn(
    { db: ctx.db, models: ctx.models, storage: ctx.storage },
    { sessionId, message, user: { firebaseUid: user.firebaseUid, role: user.role } },
  );
  const clone = response.clone();
  const consumed =
    response.status === 200 ? await consumeUiMessageStream(clone) : { text: await clone.text(), parts: [] };
  return { text: consumed.text, parts: consumed.parts, response };
}

async function run(ctx: EvalCtx): Promise<CaseResult> {
  const notes: string[] = [];
  await upsertUser(ctx.db, USER_B); // FK: chat_sessions.user_id -> users

  // User A — a real confirmed draft (client/project values + a real
  // enquiry/estimate id) via the well-tested happy-path fixture.
  const draftA = await createDraftViaHappyPath(ctx);
  notes.push(`user A draft: enquiry ${draftA.enquiryId}, estimate ${draftA.estimateId}, session ${draftA.sessionId}`);

  // User B — a brand new session, asking about "my" draft.
  const sessionB = ctx.makeSession();
  const turnB = await sendTurnAsUser(ctx, USER_B, sessionB, B_QUESTION);

  const leaksClientName = /Sarayu Heritage/i.test(turnB.text);
  const leaksProjectName = /Sarayu Riverside/i.test(turnB.text);
  const leaksEnquiryId = turnB.text.includes(draftA.enquiryId);
  const leaksEstimateId = turnB.text.includes(draftA.estimateId);
  const noLeak = !leaksClientName && !leaksProjectName && !leaksEnquiryId && !leaksEstimateId;
  notes.push(noLeak ? "user B's reply contains none of user A's values" : "user B's reply LEAKED user A's data");

  const sessionBRow = await getChatSession(ctx.db, sessionB, USER_B.firebaseUid);
  const stateB = resolveSlotState(sessionBRow?.slotState ?? null);
  const bStateEmpty = allSlotsMissing(stateB) && !sessionBRow?.enquiryId;
  notes.push(bStateEmpty ? "user B's own sessionState is empty" : "user B's own sessionState is UNEXPECTEDLY populated");

  // Direct history access to A's session, AS user B, via the router.
  const callerB = createCaller({ db: ctx.db, user: USER_B });
  let code: string | null = null;
  try {
    await callerB.chat.history({ sessionId: draftA.sessionId });
  } catch (err) {
    if (err instanceof TRPCError) code = err.code;
    else throw err;
  }
  const historyBlocked = code === "NOT_FOUND";
  notes.push(
    historyBlocked
      ? "direct history access to A's session as B is NOT_FOUND"
      : `direct history access to A's session as B returned code=${code ?? "(no error — LEAKED)"}`,
  );

  // The owner (A / the harness's own dev user) is unaffected by B's attempt.
  const ownerHistory = await createCaller({ db: ctx.db, user: ctx.user }).chat.history({ sessionId: draftA.sessionId });
  const ownerUnaffected = ownerHistory.length > 0;
  notes.push(ownerUnaffected ? "user A's own history access is unaffected" : "user A's history access broke");

  const pass = noLeak && bStateEmpty && historyBlocked && ownerUnaffected;
  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "multi-session-isolation",
  description:
    "A different user asking about 'my current enquiry draft' never sees another user's confirmed values, their own session state stays empty, and direct history access to the other user's session id is NOT_FOUND.",
  run,
};
