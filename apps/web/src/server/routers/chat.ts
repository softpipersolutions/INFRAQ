import {
  allRequiredConfirmed,
  buildEnquiryInput,
  confirmAllProposed,
  nextAction,
} from "@pebble/ai";
import {
  getChatSession,
  getOrCreateChatSession,
  linkSessionEnquiry,
  listChatMessages,
  updateSlotState,
} from "@pebble/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { checkDailyBudget, resolveSlotState } from "../chat-runtime";
import { createEnquiryAndGenerate } from "../generate";
import { protectedProcedure, router } from "../trpc";

/**
 * Chat control-plane router (spec §4.4). The conversational turn itself streams
 * over the plain route handler (app/api/chat); these procedures are the typed
 * side-channel the chat UI uses for slot-state, confirmation, history and cost.
 * All are protectedProcedure — a signed-in user is required.
 */

const sessionInput = z.object({ sessionId: z.string().min(1) });

export const chatRouter = router({
  /** Current slot-filling state for a session (fresh sessions read as empty). */
  sessionState: protectedProcedure.input(sessionInput).query(async ({ ctx, input }) => {
    const session = await getChatSession(ctx.db, input.sessionId);
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
    });
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
    await linkSessionEnquiry(ctx.db, input.sessionId, enquiryId);
    await updateSlotState(ctx.db, input.sessionId, confirmed);
    return { enquiryId, estimateId };
  }),

  /** Clear the slot state back to a fresh session (keeps the conversation row). */
  reset: protectedProcedure.input(sessionInput).mutation(async ({ ctx, input }) => {
    await getOrCreateChatSession(ctx.db, {
      sessionId: input.sessionId,
      userId: ctx.user.firebaseUid,
    });
    await updateSlotState(ctx.db, input.sessionId, null);
    return { ok: true };
  }),

  /** Full message transcript for a session, chronological. */
  history: protectedProcedure
    .input(sessionInput.extend({ limit: z.number().int().positive().max(500).optional() }))
    .query(async ({ ctx, input }) => {
      const messages = await listChatMessages(ctx.db, input.sessionId, input.limit ?? 100);
      return messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        lane: m.lane,
        model: m.model,
        createdAt: m.createdAt.toISOString(),
      }));
    }),

  /** The signed-in user's LLM spend today plus the configured daily budget. */
  costToday: protectedProcedure.query(async ({ ctx }) => {
    const budget = await checkDailyBudget(ctx.db, { userId: ctx.user.firebaseUid });
    return {
      spentUsd: budget.spentUsd,
      budgetUsd: budget.budgetUsd,
      remainingUsd: budget.remainingUsd,
      blocked: budget.blocked,
    };
  }),
});
