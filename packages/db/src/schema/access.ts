import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { AccessRequestStatus } from "@pebble/shared";

/**
 * In-app allowlist management (Access control WP). Two standalone tables the
 * admin drives from the Admin → Access page, keyed by lowercased email so the
 * auth path can resolve a sign-in with a single indexed primary-key lookup.
 * See drizzle/0007_access_control.sql for the fail-closed union semantics.
 */

/**
 * DB-managed sign-in allowlist — the runtime, no-redeploy half of the union
 * with the env allowlist. Only `active` rows grant access; deactivating a row
 * fails the offender closed on their next request. `email` is stored lowercased
 * (the repo normalizes on write).
 */
export const allowedEmails = pgTable("allowed_emails", {
  email: text("email").primaryKey(),
  /** Email (or "dev") of the admin who added/last-touched this entry. */
  addedBy: text("added_by").notNull(),
  note: text("note"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per email that was DENIED at sign-in, so an admin can approve it from
 * the dashboard. A re-attempt bumps attempt_count + last_seen and keeps the
 * earliest first_seen; status (PENDING | APPROVED | DENIED) is plain text and is
 * NEVER moved back to PENDING by a re-attempt — only the admin UI flips it.
 */
export const accessRequests = pgTable("access_requests", {
  email: text("email").primaryKey(),
  displayName: text("display_name"),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  attemptCount: integer("attempt_count").notNull().default(1),
  status: text("status").$type<AccessRequestStatus>().notNull().default("PENDING"),
});
