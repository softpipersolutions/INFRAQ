import type { AccessRequestStatus } from "@pebble/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import { accessRequests, allowedEmails } from "../schema";

/**
 * In-app allowlist + access-request repository (Access control WP).
 *
 * FAIL-CLOSED CONTRACT: `isEmailInDbAllowlist` only ever returns true for an
 * `active` row. The auth layer unions this with the env allowlist; with both
 * empty every login is denied. Emails are normalized to lowercase on every
 * write AND every read so the primary-key lookup is case-insensitive by
 * construction — a caller can pass "Foo@Bar.com" and still hit the "foo@bar.com"
 * row. House style: `db` first so these compose inside a `db.transaction`.
 */

const norm = (email: string): string => email.trim().toLowerCase();

export interface AllowedEmailRow {
  email: string;
  addedBy: string;
  note: string | null;
  active: boolean;
  createdAt: Date;
}

export interface AccessRequestRow {
  email: string;
  displayName: string | null;
  firstSeen: Date;
  lastSeen: Date;
  attemptCount: number;
  status: AccessRequestStatus;
}

function toAllowedEmail(r: typeof allowedEmails.$inferSelect): AllowedEmailRow {
  return {
    email: r.email,
    addedBy: r.addedBy,
    note: r.note,
    active: r.active,
    createdAt: r.createdAt,
  };
}

function toAccessRequest(r: typeof accessRequests.$inferSelect): AccessRequestRow {
  return {
    email: r.email,
    displayName: r.displayName,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    attemptCount: r.attemptCount,
    status: r.status,
  };
}

/**
 * Is this email present as an ACTIVE row in the DB allowlist? The runtime half
 * of the fail-closed union check. A deactivated (active = false) or missing row
 * both return false. Case-insensitive (email normalized before the PK lookup).
 */
export async function isEmailInDbAllowlist(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select({ active: allowedEmails.active })
    .from(allowedEmails)
    .where(and(eq(allowedEmails.email, norm(email)), eq(allowedEmails.active, true)))
    .limit(1);
  return rows.length > 0;
}

/** Every DB-managed allowlist entry, email-ascending (a stable order for the UI). */
export async function listAllowedEmails(db: Db): Promise<AllowedEmailRow[]> {
  const rows = await db.select().from(allowedEmails);
  return rows.map(toAllowedEmail).sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * Add (or re-activate) an allowlist entry. Idempotent upsert on the email PK:
 * a re-add always sets `active = true` and refreshes `added_by`, so approving a
 * previously-deactivated address brings it back. `note` is only overwritten when
 * explicitly provided — omitting it preserves any existing note (so an approval
 * that passes no note doesn't wipe a manual one).
 */
export async function upsertAllowedEmail(
  db: Db,
  args: { email: string; addedBy: string; note?: string | null },
): Promise<void> {
  const email = norm(args.email);
  const set: Record<string, unknown> = { addedBy: args.addedBy, active: true };
  if (args.note !== undefined) set.note = args.note;
  await db
    .insert(allowedEmails)
    .values({ email, addedBy: args.addedBy, note: args.note ?? null, active: true })
    .onConflictDoUpdate({ target: allowedEmails.email, set });
}

/**
 * Flip an allowlist entry's active flag. Deactivating (active = false) revokes
 * access on the offender's NEXT request. A no-op for a missing email.
 */
export async function setAllowedEmailActive(
  db: Db,
  args: { email: string; active: boolean },
): Promise<void> {
  await db
    .update(allowedEmails)
    .set({ active: args.active })
    .where(eq(allowedEmails.email, norm(args.email)));
}

/**
 * Log a denied sign-in attempt. Upsert on the email PK: a first attempt inserts
 * a PENDING row; a repeat attempt bumps attempt_count + last_seen and refreshes
 * display_name (when supplied) but LEAVES status and first_seen untouched — a
 * re-attempt never resurrects a DENIED (or APPROVED) request back to PENDING.
 * Returns the persisted row.
 */
export async function recordAccessRequest(
  db: Db,
  args: { email: string; displayName?: string | null },
): Promise<AccessRequestRow> {
  const email = norm(args.email);
  const set: Record<string, unknown> = {
    attemptCount: sql`${accessRequests.attemptCount} + 1`,
    lastSeen: sql`now()`,
  };
  if (args.displayName !== undefined && args.displayName !== null) {
    set.displayName = args.displayName;
  }
  const rows = await db
    .insert(accessRequests)
    .values({ email, displayName: args.displayName ?? null })
    .onConflictDoUpdate({ target: accessRequests.email, set })
    .returning();
  return toAccessRequest(rows[0]!);
}

/** Access requests, optionally filtered by status, most-recently-seen first. */
export async function listAccessRequests(
  db: Db,
  args: { status?: AccessRequestStatus } = {},
): Promise<AccessRequestRow[]> {
  const base = db.select().from(accessRequests);
  const rows = await (args.status
    ? base.where(eq(accessRequests.status, args.status))
    : base
  ).orderBy(desc(accessRequests.lastSeen));
  return rows.map(toAccessRequest);
}

/**
 * Set an access request's status (admin approve/deny, or re-approving a DENIED
 * one). A no-op for a missing email. Returns the updated row, or null if none.
 */
export async function setAccessRequestStatus(
  db: Db,
  args: { email: string; status: AccessRequestStatus },
): Promise<AccessRequestRow | null> {
  const rows = await db
    .update(accessRequests)
    .set({ status: args.status })
    .where(eq(accessRequests.email, norm(args.email)))
    .returning();
  return rows[0] ? toAccessRequest(rows[0]) : null;
}
