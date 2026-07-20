import {
  allRequiredConfirmed,
  buildEnquiryInput,
  confirmAllProposed,
  nextAction,
} from "@pebble/ai";
import {
  ChatSessionOwnershipError,
  getChatAttachment,
  getChatSession,
  getChatSessionOwner,
  getOrCreateChatSession,
  linkSessionEnquiry,
  listChatMessages,
  listChatSessions,
  registerSourceDocument,
  renameChatSession,
  setSessionArchived,
  setSessionPinned,
  sumOpusSpendSince,
  updateSlotState,
  type Db,
} from "@pebble/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { checkDailyBudget, resolveSlotState, startOfUtcDayISO } from "../chat-runtime";
import { createEnquiryAndGenerate } from "../generate";
import { protectedProcedure, roleProcedure, router } from "../trpc";

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

/**
 * `renameChatSession`/`setSessionArchived`/`setSessionPinned` are no-ops on a
 * foreign/missing row (WP0 style — a write simply matches zero rows), so the
 * router resolves ownership FIRST with a plain owner-scoped read and throws
 * `NOT_FOUND` itself before ever reaching the mutator, matching every other
 * session procedure's owner-only contract (never leaks that a foreign session
 * exists).
 */
async function requireOwnedSession(db: Db, sessionId: string, userId: string): Promise<void> {
  const session = await getChatSession(db, sessionId, userId);
  if (!session) throw SESSION_NOT_FOUND;
}

export const chatRouter = router({
  /**
   * The signed-in user's session list for the sidebar: pinned first, then most
   * recently active; archived sessions are hidden unless `includeArchived`.
   * Zero-message orphan rows never appear (see `listChatSessions`).
   */
  listSessions: protectedProcedure
    .input(z.object({ includeArchived: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const sessions = await listChatSessions(ctx.db, {
        userId: ctx.user.firebaseUid,
        includeArchived: input?.includeArchived ?? false,
      });
      return sessions.map((s) => ({
        id: s.id,
        title: s.title,
        effectiveTitle: s.effectiveTitle,
        lastMessageAt: s.lastMessageAt ? s.lastMessageAt.toISOString() : null,
        lastMessagePreview: s.lastMessagePreview,
        pinnedAt: s.pinnedAt ? s.pinnedAt.toISOString() : null,
        archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
        enquiryId: s.enquiryId,
        createdAt: s.createdAt.toISOString(),
      }));
    }),

  /** Rename a session (1..80 trimmed chars). Owner-only (NOT_FOUND otherwise). */
  rename: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), title: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnedSession(ctx.db, input.sessionId, ctx.user.firebaseUid);
      await renameChatSession(ctx.db, {
        sessionId: input.sessionId,
        userId: ctx.user.firebaseUid,
        title: input.title,
      });
      return { ok: true };
    }),

  /** Archive/unarchive a session. Owner-only (NOT_FOUND otherwise). */
  archive: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), archived: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnedSession(ctx.db, input.sessionId, ctx.user.firebaseUid);
      await setSessionArchived(ctx.db, {
        sessionId: input.sessionId,
        userId: ctx.user.firebaseUid,
        archived: input.archived,
      });
      return { ok: true };
    }),

  /** Pin/unpin a session. Owner-only (NOT_FOUND otherwise). */
  pin: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), pinned: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnedSession(ctx.db, input.sessionId, ctx.user.firebaseUid);
      await setSessionPinned(ctx.db, {
        sessionId: input.sessionId,
        userId: ctx.user.firebaseUid,
        pinned: input.pinned,
      });
      return { ok: true };
    }),

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
   * Send an uploaded PDF chat attachment into the ingestion corpus
   * (admin/estimator). Ingestion handoff choice (WP8 §4): this REGISTERS the
   * file as a source document (idempotent on storage_uri — a re-send returns
   * the existing id) and returns immediately. It deliberately does NOT run the
   * ingestion pipeline inline — a full PDF ingest spans several model calls and
   * would hang a chat interaction — so the registered doc lands in the corpus
   * at REGISTERED, where the existing ingest path (the admin "Re-ingest" action
   * / the backfill driver) processes it. This reuses the same
   * `registerSourceDocument` the corpus already uses, so no new pipeline is
   * introduced. Owner-scoped: the attachment must belong to the caller.
   */
  sendToIngestion: roleProcedure("estimator")
    .input(z.object({ attachmentId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const attachment = await getChatAttachment(ctx.db, {
        id: input.attachmentId,
        userId: ctx.user.firebaseUid,
      });
      if (!attachment) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Attachment not found." });
      }
      if (attachment.mediaType.trim().toLowerCase() !== "application/pdf") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only PDF attachments can be sent to ingestion.",
        });
      }

      const { id: sourceDocumentId, existing } = await registerSourceDocument(ctx.db, {
        filename: attachment.filename,
        storageUri: attachment.storageUri,
        docType: "pdf",
        pageCount: attachment.pageCount,
      });
      return {
        registered: true,
        sourceDocumentId,
        existing,
        note: existing
          ? "This file was already in the ingestion corpus."
          : "Registered for ingestion — it will be processed and appear in the verification queue.",
      };
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
