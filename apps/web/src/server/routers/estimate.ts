import {
  approveVersion,
  forkWorkingVersion,
  getEnquiry,
  getEstimate,
  getVersionWithLines,
  listAuditForEstimate,
  listVersions,
  type VersionWithLines,
} from "@pebble/db";
import { diffVersions } from "@pebble/engines";
import type { GenerationWarning } from "@pebble/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { generateForEnquiry } from "../generate";
import { addLine, editLine, removeLine, type Actor } from "../recompute";
import { publicProcedure, router } from "../trpc";

function warningsOf(view: VersionWithLines | null): GenerationWarning[] {
  const raw = view?.version.snapshot?.["warnings"];
  return Array.isArray(raw) ? (raw as GenerationWarning[]) : [];
}

function actorOf(ctx: { user: { firebaseUid: string; role: string } }): Actor {
  return { actor: ctx.user.firebaseUid, actorRole: ctx.user.role };
}

const estimateId = z.object({ estimateId: z.string() });

export const estimateRouter = router({
  /** Estimate header + current version + lines + enquiry context + warnings. */
  get: publicProcedure.input(estimateId).query(async ({ ctx, input }) => {
    const view = await getVersionWithLines(ctx.db, input.estimateId);
    if (!view) throw new TRPCError({ code: "NOT_FOUND", message: "Estimate not found" });
    const enquiry = await getEnquiry(ctx.db, view.estimate.enquiryId);
    const versions = await listVersions(ctx.db, input.estimateId);
    return {
      estimate: view.estimate,
      version: view.version,
      lines: view.lines,
      enquiry,
      warnings: warningsOf(view),
      versions,
    };
  }),

  getVersion: publicProcedure
    .input(estimateId.extend({ versionNo: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const view = await getVersionWithLines(ctx.db, input.estimateId, input.versionNo);
      if (!view) throw new TRPCError({ code: "NOT_FOUND", message: "Version not found" });
      const enquiry = await getEnquiry(ctx.db, view.estimate.enquiryId);
      const versions = await listVersions(ctx.db, input.estimateId);
      return {
        estimate: view.estimate,
        version: view.version,
        lines: view.lines,
        enquiry,
        warnings: warningsOf(view),
        versions,
      };
    }),

  listVersions: publicProcedure.input(estimateId).query(async ({ ctx, input }) => {
    return listVersions(ctx.db, input.estimateId);
  }),

  /** Fork the LOCKED current version into a WORKING copy for review/editing. */
  startReview: publicProcedure.input(estimateId).mutation(async ({ ctx, input }) => {
    const who = actorOf(ctx);
    const version = await forkWorkingVersion(ctx.db, input.estimateId, who.actor, who.actorRole);
    return { versionNo: version.versionNo };
  }),

  editLine: publicProcedure
    .input(
      estimateId.extend({
        lineUid: z.string(),
        qty: z.number().nonnegative().optional(),
        makeCode: z.string().optional(),
        note: z.string().nullable().optional(),
        editReason: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await editLine(ctx.db, actorOf(ctx), {
        estimateId: input.estimateId,
        lineUid: input.lineUid,
        qty: input.qty,
        makeCode: input.makeCode,
        note: input.note,
        editReason: input.editReason,
      });
      return { ok: true };
    }),

  addLine: publicProcedure
    .input(
      estimateId.extend({
        materialCode: z.string(),
        qty: z.number().nonnegative(),
        note: z.string().nullable().optional(),
        editReason: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await addLine(ctx.db, actorOf(ctx), {
        estimateId: input.estimateId,
        materialCode: input.materialCode,
        qty: input.qty,
        note: input.note,
        editReason: input.editReason,
      });
      return { ok: true };
    }),

  removeLine: publicProcedure
    .input(estimateId.extend({ lineUid: z.string(), editReason: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await removeLine(ctx.db, actorOf(ctx), {
        estimateId: input.estimateId,
        lineUid: input.lineUid,
        editReason: input.editReason,
      });
      return { ok: true };
    }),

  /**
   * Approve (lock) the working version. Gate: a SITC ALERT blocks approval
   * unless overrideSitc is set; a BELOW_FLOOR margin does not block but the
   * required discount authority is surfaced back to the caller.
   */
  approve: publicProcedure
    .input(estimateId.extend({ overrideSitc: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const estimate = await getEstimate(ctx.db, input.estimateId);
      if (!estimate) throw new TRPCError({ code: "NOT_FOUND", message: "Estimate not found" });

      if (estimate.sitcStatus === "ALERT" && !input.overrideSitc) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "SITC ratio is outside the 1.35–1.51 band (ALERT). Approval requires an explicit override.",
        });
      }

      const who = actorOf(ctx);
      await approveVersion(ctx.db, input.estimateId, who.actor, who.actorRole);
      return {
        approved: true,
        marginStatus: estimate.marginStatus,
        requiredAuthority: estimate.requiredAuthority,
      };
    }),

  audit: publicProcedure.input(estimateId).query(async ({ ctx, input }) => {
    const events = await listAuditForEstimate(ctx.db, input.estimateId);
    return events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      actor: e.actor,
      actorRole: e.actorRole,
      version: e.version,
      ts: e.ts.toISOString(),
      payload: e.payload,
    }));
  }),

  compare: publicProcedure
    .input(estimateId.extend({ versionA: z.number().int().positive(), versionB: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const a = await getVersionWithLines(ctx.db, input.estimateId, input.versionA);
      const b = await getVersionWithLines(ctx.db, input.estimateId, input.versionB);
      if (!a || !b) throw new TRPCError({ code: "NOT_FOUND", message: "Version not found" });
      return {
        a: a.version,
        b: b.version,
        diff: diffVersions(a.lines, b.lines),
      };
    }),

  /** Optional: re-run generation from the source enquiry into a fresh estimate. */
  regenerate: publicProcedure.input(estimateId).mutation(async ({ ctx, input }) => {
    const estimate = await getEstimate(ctx.db, input.estimateId);
    if (!estimate) throw new TRPCError({ code: "NOT_FOUND", message: "Estimate not found" });
    const who = actorOf(ctx);
    const newEstimateId = await generateForEnquiry(
      ctx.db,
      estimate.enquiryId,
      who.actor,
      who.actorRole,
    );
    return { estimateId: newEstimateId };
  }),
});
