import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import {
  auditEventTypeEnum,
  dispatchChannelEnum,
  dispatchStatusEnum,
  documentKindEnum,
} from "./enums";
import { estimates, estimateVersions } from "./estimates";

/**
 * Audit trail + output/dispatch tables (spec section D).
 * audit_events is append-only — the migration installs a BEFORE UPDATE OR
 * DELETE trigger that raises. Ids are monotonic ULIDs, so ordering by id
 * gives strict event order even within one millisecond.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(), // monotonic ULID
    eventType: auditEventTypeEnum("event_type").notNull(),
    estimateId: text("estimate_id"),
    enquiryId: text("enquiry_id"),
    version: integer("version"),
    actor: text("actor").notNull(),
    actorRole: text("actor_role"),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("audit_events_estimate_id_id_idx").on(t.estimateId, t.id)],
);

/** Rendered outputs (Format A PDF / XLSX) for one estimate version. */
export const generatedDocuments = pgTable("generated_documents", {
  id: text("id").primaryKey(), // ULID
  estimateVersionId: text("estimate_version_id")
    .notNull()
    .references(() => estimateVersions.id),
  format: text("format").notNull().default("A"),
  kind: documentKindEnum("kind").notNull(),
  storageUri: text("storage_uri").notNull(),
  sha256: text("sha256").notNull(),
  generatedBy: text("generated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Outbound dispatches (email / WhatsApp) of generated documents. */
export const dispatches = pgTable("dispatches", {
  id: text("id").primaryKey(), // ULID
  estimateId: text("estimate_id")
    .notNull()
    .references(() => estimates.estimateId),
  documentIds: text("document_ids").array().notNull(),
  channel: dispatchChannelEnum("channel").notNull(),
  recipient: text("recipient").notNull(),
  provider: text("provider").notNull(),
  status: dispatchStatusEnum("status").notNull(),
  providerMessageId: text("provider_message_id"),
  error: text("error"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
