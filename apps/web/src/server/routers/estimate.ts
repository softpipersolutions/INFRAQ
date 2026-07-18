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
import type { DispatchAttachment } from "@pebble/dispatch";
import { diffVersions } from "@pebble/engines";
import { formatINR, type GenerationWarning } from "@pebble/shared";
import { WorkerError } from "@pebble/worker";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { generateForEnquiry } from "../generate";
import { listDispatchesForEstimate, listDocumentsForEstimate } from "../queries";
import { addLine, editLine, removeLine, type Actor } from "../recompute";
import { protectedProcedure, roleProcedure, router } from "../trpc";
import { createWorkerClient } from "../worker-client";

function warningsOf(view: VersionWithLines | null): GenerationWarning[] {
  const raw = view?.version.snapshot?.["warnings"];
  return Array.isArray(raw) ? (raw as GenerationWarning[]) : [];
}

function actorOf(ctx: { user: { firebaseUid: string; role: string } }): Actor {
  return { actor: ctx.user.firebaseUid, actorRole: ctx.user.role };
}

const estimateId = z.object({ estimateId: z.string() });

/**
 * Translate a worker failure into a typed TRPC error, preserving the worker's
 * own message (e.g. the "only LOCKED versions can be rendered" 400 guard) so
 * the UI can surface it verbatim.
 */
function fromWorkerError(err: unknown): TRPCError {
  if (err instanceof WorkerError) {
    const code =
      err.status === 404 ? "NOT_FOUND" : err.status < 500 ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR";
    return new TRPCError({ code, message: err.message });
  }
  if (err instanceof TRPCError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
}

export const estimateRouter = router({
  /** Estimate header + current version + lines + enquiry context + warnings. */
  get: protectedProcedure.input(estimateId).query(async ({ ctx, input }) => {
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

  getVersion: protectedProcedure
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

  listVersions: protectedProcedure.input(estimateId).query(async ({ ctx, input }) => {
    return listVersions(ctx.db, input.estimateId);
  }),

  /** Fork the LOCKED current version into a WORKING copy for review/editing. */
  startReview: protectedProcedure.input(estimateId).mutation(async ({ ctx, input }) => {
    const who = actorOf(ctx);
    const version = await forkWorkingVersion(ctx.db, input.estimateId, who.actor, who.actorRole);
    return { versionNo: version.versionNo };
  }),

  editLine: protectedProcedure
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

  addLine: protectedProcedure
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

  removeLine: protectedProcedure
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
  approve: roleProcedure("approver")
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

  /**
   * Render the Format A PDF + XLSX for a LOCKED version via the worker
   * (in-process in dev, HTTP+OIDC in production). Money is never recomputed
   * here — the worker renders from the persisted version totals.
   */
  render: roleProcedure("estimator", "approver")
    .input(estimateId.extend({ versionNo: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const worker = createWorkerClient(ctx.db);
      try {
        const result = await worker.render({
          estimateId: input.estimateId,
          versionNo: input.versionNo,
          actor: ctx.user.firebaseUid,
        });
        return [
          { id: result.pdf.id, docType: "PDF" as const, uri: result.pdf.uri, sha256: result.pdf.sha256 },
          { id: result.xlsx.id, docType: "XLSX" as const, uri: result.xlsx.uri, sha256: result.xlsx.sha256 },
        ];
      } catch (err) {
        throw fromWorkerError(err);
      }
    }),

  /**
   * Send the latest rendered documents to the client over the selected
   * channels. Approver-only: dispatching a priced estimate is an external
   * commitment. Recipients fall back to the enquiry's contact details.
   */
  dispatchDocs: roleProcedure("approver")
    .input(
      estimateId.extend({
        channels: z.array(z.enum(["email", "whatsapp"])).min(1),
        recipientEmail: z.string().email().optional(),
        recipientPhone: z.string().min(6).max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const view = await getVersionWithLines(ctx.db, input.estimateId);
      if (!view) throw new TRPCError({ code: "NOT_FOUND", message: "Estimate not found" });
      const enquiry = await getEnquiry(ctx.db, view.estimate.enquiryId);
      if (!enquiry) throw new TRPCError({ code: "NOT_FOUND", message: "Enquiry not found" });

      // Per-channel recipient resolution (explicit input beats enquiry contact).
      const wantsEmail = input.channels.includes("email");
      const wantsWhatsApp = input.channels.includes("whatsapp");
      const toEmail = wantsEmail ? input.recipientEmail ?? enquiry.clientEmail ?? null : null;
      const toPhone = wantsWhatsApp ? input.recipientPhone ?? enquiry.clientPhone ?? null : null;
      if (wantsEmail && !toEmail) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Email channel selected but no recipient email (enquiry has none on file)",
        });
      }
      if (wantsWhatsApp && !toPhone) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "WhatsApp channel selected but no recipient phone (enquiry has none on file)",
        });
      }

      // Latest rendered artifacts (newest first) — one PDF + one XLSX. The
      // dispatch references stored uris; nothing is re-rendered or recomputed.
      const documents = await listDocumentsForEstimate(ctx.db, input.estimateId);
      const pdf = documents.find((d) => d.docType === "PDF");
      const xlsx = documents.find((d) => d.docType === "XLSX");
      if (!pdf && !xlsx) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No generated documents to send — generate PDF/Excel first",
        });
      }
      const picked = [pdf, xlsx].filter((d) => d !== undefined);
      const attachments: DispatchAttachment[] = picked.map((d) => ({
        filename: `${input.estimateId}.${d.docType === "PDF" ? "pdf" : "xlsx"}`,
        url: d.uri,
      }));

      const worker = createWorkerClient(ctx.db);
      try {
        const results = await worker.dispatch({
          estimateId: input.estimateId,
          toEmail: toEmail ?? undefined,
          toPhone: toPhone ?? undefined,
          subject: `Estimate ${input.estimateId} — ${enquiry.projectName}`,
          message:
            `Dear ${enquiry.clientName},\n\n` +
            `Please find the fire safety BOQ estimate ${input.estimateId} for ` +
            `${enquiry.projectName} (grand total ${formatINR(view.version.grandTotalPaise)}, ` +
            `incl. GST) attached.\n\nRegards,\nGreenberg Engineering`,
          attachments,
          documentIds: picked.map((d) => d.id),
          actor: ctx.user.firebaseUid,
        });
        return results.map(({ channel, result }) => ({
          channel,
          status: result.status,
          provider: result.provider,
          providerMessageId: result.providerMessageId ?? null,
          error: result.error ?? null,
        }));
      } catch (err) {
        throw fromWorkerError(err);
      }
    }),

  /** Rendered outputs (all versions, newest first). */
  documents: protectedProcedure.input(estimateId).query(async ({ ctx, input }) => {
    return listDocumentsForEstimate(ctx.db, input.estimateId);
  }),

  /** Outbox history (newest first). */
  dispatches: protectedProcedure.input(estimateId).query(async ({ ctx, input }) => {
    return listDispatchesForEstimate(ctx.db, input.estimateId);
  }),

  audit: protectedProcedure.input(estimateId).query(async ({ ctx, input }) => {
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

  compare: protectedProcedure
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
  regenerate: protectedProcedure.input(estimateId).mutation(async ({ ctx, input }) => {
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
