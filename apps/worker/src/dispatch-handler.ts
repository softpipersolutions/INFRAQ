import type { Db } from "@pebble/db";
import { appendAudit, newUlid } from "@pebble/db";
import { dispatches } from "@pebble/db/schema";
import type {
  ChannelDispatchResult,
  DispatchAttachment,
  DispatchProviders,
} from "@pebble/dispatch";
import { dispatchEstimate } from "@pebble/dispatch";
import type { DispatchChannel } from "@pebble/shared";
import { WorkerError } from "./errors";

/**
 * Persisting side of a dispatch (PLAN §4.7 — outbox pattern). `@pebble/dispatch`
 * fans one request out to email + WhatsApp and returns a `SendResult` per
 * channel; here we translate each result into a `dispatches` row and an
 * `EST_DISPATCHED` audit event, all in one transaction so the outbox record and
 * its audit intent commit atomically. The pure send layer stays persistence-free
 * by design; this is the only place that writes.
 */

export interface DispatchDeps {
  db: Db;
  providers: DispatchProviders;
}

export interface DispatchArgs {
  estimateId: string;
  /** Email recipient(s). Omit to skip email (or leave the provider unset). */
  toEmail?: string | string[];
  /** WhatsApp recipient MSISDN. Omit to skip WhatsApp. */
  toPhone?: string;
  subject: string;
  message: string;
  /** Optional rich HTML email body. */
  html?: string;
  /** Shared branded artifacts (PDF / Excel). */
  attachments?: DispatchAttachment[];
  /** `generated_documents` ids referenced by this dispatch (provenance). */
  documentIds?: string[];
  /** Audit / outbox actor; defaults to `"worker"`. */
  actor?: string;
}

/** Recipient string persisted on the outbox row, per channel. */
function recipientFor(channel: DispatchChannel, args: DispatchArgs): string {
  if (channel === "EMAIL") {
    return Array.isArray(args.toEmail) ? args.toEmail.join(", ") : args.toEmail ?? "";
  }
  return args.toPhone ?? "";
}

export async function dispatchEstimateDocuments(
  deps: DispatchDeps,
  args: DispatchArgs,
): Promise<ChannelDispatchResult[]> {
  const { db, providers } = deps;
  const actor = args.actor ?? "worker";
  const documentIds = args.documentIds ?? [];

  if (!args.toEmail && !args.toPhone) {
    throw new WorkerError("Dispatch requires at least one of toEmail / toPhone", 400);
  }

  // Fan out (pure — no DB writes here).
  const results = await dispatchEstimate(providers, {
    toEmail: args.toEmail,
    toPhone: args.toPhone,
    subject: args.subject,
    message: args.message,
    html: args.html,
    attachments: args.attachments,
  });

  // Persist one outbox row + one audit event per channel that actually sent.
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    for (const { channel, result } of results) {
      const recipient = recipientFor(channel, args);
      await tx.insert(dispatches).values({
        id: newUlid(),
        estimateId: args.estimateId,
        documentIds,
        channel,
        recipient,
        provider: result.provider,
        status: result.status,
        providerMessageId: result.providerMessageId ?? null,
        error: result.error ?? null,
        createdBy: actor,
      });

      await appendAudit(tx, {
        eventType: "EST_DISPATCHED",
        actor,
        estimateId: args.estimateId,
        payload: {
          channel,
          recipient,
          provider: result.provider,
          status: result.status,
          providerMessageId: result.providerMessageId ?? null,
          documentIds,
        },
      });
    }
  });

  return results;
}
