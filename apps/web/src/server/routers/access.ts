import {
  listAccessRequests,
  listAllowedEmails,
  recordAccessRequest,
  setAccessRequestStatus,
  setAllowedEmailActive,
  upsertAllowedEmail,
} from "@pebble/db";
import { ACCESS_REQUEST_STATUSES } from "@pebble/shared";
import { z } from "zod";
import { parseEnvAllowlist } from "../auth";
import { roleProcedure, router } from "../trpc";

/**
 * Access control router (in-app allowlist management + access requests). Every
 * procedure is admin-only (roleProcedure("admin")) — this is the security
 * boundary for who may sign in at all, so it must never be reachable by an
 * estimator/approver.
 *
 * The APPROVAL FLOW is deliberately two writes with no redeploy: `approve`
 * upserts an ACTIVE allowed_emails row AND stamps the request APPROVED, so the
 * person just signs in again and the existing first-login flow provisions them
 * as estimator. Deactivating/denying is the inverse.
 */

const emailInput = z
  .string()
  .trim()
  .email()
  .transform((e) => e.toLowerCase());

export const accessRouter = router({
  /** Access requests, optionally filtered by status; ISO dates for the client. */
  requests: roleProcedure("admin")
    .input(z.object({ status: z.enum(ACCESS_REQUEST_STATUSES).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const rows = await listAccessRequests(ctx.db, { status: input?.status });
      return rows.map((r) => ({
        email: r.email,
        displayName: r.displayName,
        firstSeen: r.firstSeen.toISOString(),
        lastSeen: r.lastSeen.toISOString(),
        attemptCount: r.attemptCount,
        status: r.status,
      }));
    }),

  /** Count of PENDING requests — drives the admin hub card badge. */
  pendingCount: roleProcedure("admin").query(async ({ ctx }) => {
    const rows = await listAccessRequests(ctx.db, { status: "PENDING" });
    return rows.length;
  }),

  /** The DB-managed allowlist entries (email-ascending), ISO dates for the client. */
  allowed: roleProcedure("admin").query(async ({ ctx }) => {
    const rows = await listAllowedEmails(ctx.db);
    return rows.map((r) => ({
      email: r.email,
      addedBy: r.addedBy,
      note: r.note,
      active: r.active,
      createdAt: r.createdAt.toISOString(),
    }));
  }),

  /** The deploy-baked env allowlist, display-only ("configured at deploy"). */
  envConfig: roleProcedure("admin").query(() => parseEnvAllowlist()),

  /**
   * Approve an access request: activate the email in the DB allowlist AND mark
   * the request APPROVED. The user signs in again and is provisioned by the
   * existing first-login flow. Works on a PENDING or a previously-DENIED row.
   */
  approve: roleProcedure("admin")
    .input(z.object({ email: emailInput }))
    .mutation(async ({ ctx, input }) => {
      await upsertAllowedEmail(ctx.db, { email: input.email, addedBy: ctx.user.email });
      const updated = await setAccessRequestStatus(ctx.db, {
        email: input.email,
        status: "APPROVED",
      });
      // No logged attempt (an admin approving an address that never tried to
      // sign in) — create the request row so the approval shows in history.
      if (!updated) {
        await recordAccessRequest(ctx.db, { email: input.email });
        await setAccessRequestStatus(ctx.db, { email: input.email, status: "APPROVED" });
      }
      return { ok: true };
    }),

  /** Deny an access request (leaves the allowlist untouched; a re-attempt stays DENIED). */
  deny: roleProcedure("admin")
    .input(z.object({ email: emailInput }))
    .mutation(async ({ ctx, input }) => {
      await setAccessRequestStatus(ctx.db, { email: input.email, status: "DENIED" });
      return { ok: true };
    }),

  /** Proactively add (or re-activate) an allowlist entry, ahead of any request. */
  addEmail: roleProcedure("admin")
    .input(z.object({ email: emailInput, note: z.string().trim().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      await upsertAllowedEmail(ctx.db, {
        email: input.email,
        addedBy: ctx.user.email,
        note: input.note && input.note.length > 0 ? input.note : undefined,
      });
      return { ok: true };
    }),

  /** Deactivate / reactivate an allowlist entry (deactivate fails the user closed next request). */
  setActive: roleProcedure("admin")
    .input(z.object({ email: emailInput, active: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await setAllowedEmailActive(ctx.db, { email: input.email, active: input.active });
      return { ok: true };
    }),
});
