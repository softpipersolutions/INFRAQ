import {
  allRequiredConfirmed,
  buildEnquiryInput,
  confirmAllProposed,
  nextAction,
} from "@pebble/ai";
import {
  ChatSessionOwnershipError,
  getChatSession,
  getChatSessionOwner,
  getOrCreateChatSession,
  linkSessionEnquiry,
  listChatMessages,
  sumOpusSpendSince,
  updateSlotState,
} from "@pebble/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { checkDailyBudget, resolveSlotState, startOfUtcDayISO } from "../chat-runtime";
import { createEnquiryAndGenerate } from "../generate";
import { protectedProcedure, router } from "../trpc";

/**
 * Chat control-plane router (spec §4.4). The conversational turn itself streams
 * over the plain route handler (app/api/chat); these procedures are the typed
 * side-channel the chat UI uses for slot-state, confirmation, history and cost.
 * All are protectedProcedure — a signed-in user is required.
 *
 * SESSION OWNERSHIP: every procedure passes `ctx.user.firebaseUid` into the repo
 * so a session is only readable/mutable by the user who owns it — strict
 * owner-only, admins included. A non-owned (or non-existent) session surfaces as
 * `NOT_FOUND`, never `FORBIDDEN`, so we never leak that another user's session
 * exists. The one nuance is `sessionState`: a brand-new (never-created) UUID is
 * NOT an error — it reads back as a fresh empty state (the UI polls it before the
 * first turn creates the row) — but a UUID that already belongs to someone else
 * is `NOT_FOUND`.
 */

const sessionInput = z.object({ sessionId: z.string().min(1) });

/** Map the repo's foreign-owner throw to NOT_FOUND (never FORBIDDEN — no existence leak). */
const SESSION_NOT_FOUND = new TRPCError({ code: "NOT_FOUND", message: "Session not found." });
function notFoundIfForeign(err: unknown): never {
  if (err instanceof ChatSessionOwnershipError) throw SESSION_NOT_FOUND;
  throw err;
}

export const chatRouter = router({
  /** Current slot-filling state for a session (fresh sessions read as empty). */
  sessionState: protectedProcedure.input(sessionInput).query(async ({ ctx, input }) => {
    const session = await getChatSession(ctx.db, input.sessionId, ctx.user.firebaseUid);
    // Owned → use it. Not owned but the row EXISTS (someone else's) → NOT_FOUND.
    // Truly absent → treat as a fresh, empty session (the UI polls before turn 1).
    if (!session && (await getChatSessionOwner(ctx.db, input.sessionId)) !== null) {
      throw SESSION_NOT_FOUND;
    }
    const slotState = resolveSlotState(session?.slotState ?? null);
    const na = nextAction(slotState);
    const enquiryId = session?.enquiryId ?? null;
    return {
      slotState,
      enquiryId,
      // The UI shows Confirm once every required field is captured (proposed or
      // confirmed) — and never again once the enquiry exists (a reloaded page
      // otherwise re-offers a Confirm that can only 409).
      readyToConfirm: enquiryId === null && na.kind !== "ask",
      allConfirmed: allRequiredConfirmed(slotState),
    };
  }),

  /**
   * Confirm the captured enquiry: mark every proposed slot confirmed, assemble
   * a validated EnquiryInput (same schema as the form), then run the shared
   * create+generate path and link the resulting enquiry to the session. Audit
   * (ENQ_CREATED → generation events) comes free from the underlying service.
   */
  confirmEnquiry: protectedProcedure.input(sessionInput).mutation(async ({ ctx, input }) => {
    const session = await getOrCreateChatSession(ctx.db, {
      sessionId: input.sessionId,
      userId: ctx.user.firebaseUid,
    }).catch(notFoundIfForeign);
    if (session.enquiryId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `This session already created enquiry ${session.enquiryId}.`,
      });
    }

    const confirmed = confirmAllProposed(resolveSlotState(session.slotState));
    const built = buildEnquiryInput(confirmed);
    if (!built.ok || !built.input) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Enquiry is incomplete: ${(built.issues ?? []).join("; ") || "missing required fields"}`,
      });
    }

    const { enquiryId, estimateId } = await createEnquiryAndGenerate(
      ctx.db,
      built.input,
      ctx.user.firebaseUid,
      ctx.user.role,
    );
    await linkSessionEnquiry(ctx.db, input.sessionId, ctx.user.firebaseUid, enquiryId);
    await updateSlotState(ctx.db, input.sessionId, ctx.user.firebaseUid, confirmed);
    return { enquiryId, estimateId };
  }),

  /** Clear the slot state back to a fresh session (keeps the conversation row). */
  reset: protectedProcedure.input(sessionInput).mutation(async ({ ctx, input }) => {
    await getOrCreateChatSession(ctx.db, {
      sessionId: input.sessionId,
      userId: ctx.user.firebaseUid,
    }).catch(notFoundIfForeign);
    await updateSlotState(ctx.db, input.sessionId, ctx.user.firebaseUid, null);
    return { ok: true };
  }),

  /** Full message transcript for a session, chronological. Owner-only (NOT_FOUND otherwise). */
  history: protectedProcedure
    .input(sessionInput.extend({ limit: z.number().int().positive().max(500).optional() }))
    .query(async ({ ctx, input }) => {
      // Resolve an owned session first; listChatMessages is session-id-keyed and
      // must never be reached for a session the caller does not own.
      const session = await getChatSession(ctx.db, input.sessionId, ctx.user.firebaseUid);
      if (!session) throw SESSION_NOT_FOUND;
      const messages = await listChatMessages(ctx.db, input.sessionId, input.limit ?? 100);
      return messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        lane: m.lane,
        model: m.model,
        // Tool-activity + receipt parts for reload fidelity (null on legacy text-only rows).
        parts: m.parts,
        createdAt: m.createdAt.toISOString(),
      }));
    }),

  /**
   * The signed-in user's LLM spend today plus the configured daily budget, and
   * the Opus-only slice of that spend (for the dashboard escalation tile).
   */
  costToday: protectedProcedure.query(async ({ ctx }) => {
    const budget = await checkDailyBudget(ctx.db, { userId: ctx.user.firebaseUid });
    const opus = await sumOpusSpendSince(ctx.db, {
      userId: ctx.user.firebaseUid,
      sinceISO: startOfUtcDayISO(),
    });
    return {
      spentUsd: budget.spentUsd,
      budgetUsd: budget.budgetUsd,
      remainingUsd: budget.remainingUsd,
      blocked: budget.blocked,
      opusSpentToday: opus.costUsd,
    };
  }),
});
