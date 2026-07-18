import type { AuditEventType } from "@pebble/shared";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { newUlid } from "../ids";
import { auditEvents } from "../schema";

/**
 * Append-only audit trail (spec section D). Every event MUST be written in the
 * same transaction as the state change it describes — pass the transaction as
 * `db`. The table's trigger rejects any later UPDATE/DELETE, so ids (monotonic
 * ULIDs) give a tamper-evident, strictly-ordered timeline.
 */

export interface NewAuditEvent {
  eventType: AuditEventType;
  actor: string;
  actorRole?: string | null;
  estimateId?: string | null;
  enquiryId?: string | null;
  version?: number | null;
  payload: Record<string, unknown>;
}

export async function appendAudit(db: Db, event: NewAuditEvent): Promise<string> {
  const id = newUlid();
  await db.insert(auditEvents).values({
    id,
    eventType: event.eventType,
    actor: event.actor,
    actorRole: event.actorRole ?? null,
    estimateId: event.estimateId ?? null,
    enquiryId: event.enquiryId ?? null,
    version: event.version ?? null,
    payload: event.payload,
  });
  return id;
}

export interface AuditEventRow {
  id: string;
  eventType: AuditEventType;
  actor: string;
  actorRole: string | null;
  estimateId: string | null;
  enquiryId: string | null;
  version: number | null;
  ts: Date;
  payload: Record<string, unknown>;
}

/** Full timeline for an estimate, in strict chronological (id) order. */
export async function listAuditForEstimate(db: Db, estimateId: string): Promise<AuditEventRow[]> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.estimateId, estimateId))
    .orderBy(asc(auditEvents.id));
  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    actor: r.actor,
    actorRole: r.actorRole ?? null,
    estimateId: r.estimateId ?? null,
    enquiryId: r.enquiryId ?? null,
    version: r.version ?? null,
    ts: r.ts,
    payload: r.payload,
  }));
}
