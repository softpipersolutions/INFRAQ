import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db, DbHandle } from "../src/index";
import {
  createDb,
  isEmailInDbAllowlist,
  listAccessRequests,
  listAllowedEmails,
  migrateDb,
  recordAccessRequest,
  setAccessRequestStatus,
  setAllowedEmailActive,
  upsertAllowedEmail,
} from "../src/index";
import { freshDb } from "./helpers";

/**
 * Access control repos (in-app allowlist management). Fail-closed allowlist
 * semantics (only ACTIVE rows grant access) and access-request upsert semantics
 * (bump attempt_count, keep earliest first_seen, never resurrect a DENIED row).
 */

let handle: DbHandle;
let db: Db;
beforeEach(async () => {
  handle = await freshDb();
  db = handle.db as unknown as Db;
});
afterEach(async () => {
  await handle.close();
});

describe("0007 access_control migration", () => {
  it("applies 0007_access_control.sql on a fresh database", async () => {
    const fresh = await createDb({ pglite: true, pgliteDir: "memory://" });
    try {
      const applied = await migrateDb(fresh);
      expect(applied).toContain("0007_access_control.sql");
    } finally {
      await fresh.close();
    }
  });
});

describe("allowed_emails", () => {
  it("upsert makes an email allowed; deactivating fails it closed", async () => {
    expect(await isEmailInDbAllowlist(db, "person@acme.com")).toBe(false);

    await upsertAllowedEmail(db, { email: "person@acme.com", addedBy: "admin@greenberg.test" });
    expect(await isEmailInDbAllowlist(db, "person@acme.com")).toBe(true);

    await setAllowedEmailActive(db, { email: "person@acme.com", active: false });
    expect(await isEmailInDbAllowlist(db, "person@acme.com")).toBe(false);

    await setAllowedEmailActive(db, { email: "person@acme.com", active: true });
    expect(await isEmailInDbAllowlist(db, "person@acme.com")).toBe(true);
  });

  it("stores + looks up emails lowercased (case-insensitive)", async () => {
    await upsertAllowedEmail(db, { email: "Mixed.Case@Acme.COM", addedBy: "admin" });
    expect(await isEmailInDbAllowlist(db, "mixed.case@acme.com")).toBe(true);
    expect(await isEmailInDbAllowlist(db, "MIXED.CASE@ACME.COM")).toBe(true);
    const rows = await listAllowedEmails(db);
    expect(rows.map((r) => r.email)).toEqual(["mixed.case@acme.com"]);
  });

  it("re-adding a deactivated email reactivates it and keeps the note when omitted", async () => {
    await upsertAllowedEmail(db, { email: "p@acme.com", addedBy: "admin", note: "first note" });
    await setAllowedEmailActive(db, { email: "p@acme.com", active: false });

    await upsertAllowedEmail(db, { email: "p@acme.com", addedBy: "admin2" });
    const rows = await listAllowedEmails(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.active).toBe(true);
    expect(rows[0]!.addedBy).toBe("admin2");
    // Note preserved because it wasn't supplied on the reactivation.
    expect(rows[0]!.note).toBe("first note");
  });

  it("lists allowlist entries email-ascending", async () => {
    await upsertAllowedEmail(db, { email: "zed@acme.com", addedBy: "a" });
    await upsertAllowedEmail(db, { email: "amy@acme.com", addedBy: "a" });
    await upsertAllowedEmail(db, { email: "mo@acme.com", addedBy: "a" });
    const rows = await listAllowedEmails(db);
    expect(rows.map((r) => r.email)).toEqual(["amy@acme.com", "mo@acme.com", "zed@acme.com"]);
  });
});

describe("access_requests", () => {
  it("first record inserts a PENDING row with attempt_count 1", async () => {
    const row = await recordAccessRequest(db, { email: "new@acme.com", displayName: "New Person" });
    expect(row.status).toBe("PENDING");
    expect(row.attemptCount).toBe(1);
    expect(row.displayName).toBe("New Person");
  });

  it("re-attempt bumps attempt_count + last_seen and keeps the earliest first_seen", async () => {
    const first = await recordAccessRequest(db, { email: "again@acme.com" });
    await new Promise((r) => setTimeout(r, 5));
    const second = await recordAccessRequest(db, { email: "again@acme.com" });

    expect(second.attemptCount).toBe(2);
    expect(second.firstSeen.getTime()).toBe(first.firstSeen.getTime());
    expect(second.lastSeen.getTime()).toBeGreaterThanOrEqual(first.lastSeen.getTime());
  });

  it("does NOT resurrect a DENIED request back to PENDING on re-attempt", async () => {
    await recordAccessRequest(db, { email: "rej@acme.com" });
    await setAccessRequestStatus(db, { email: "rej@acme.com", status: "DENIED" });

    const reattempt = await recordAccessRequest(db, { email: "rej@acme.com" });
    expect(reattempt.status).toBe("DENIED");
    expect(reattempt.attemptCount).toBe(2);
  });

  it("refreshes display_name when supplied, preserves it when omitted", async () => {
    await recordAccessRequest(db, { email: "dn@acme.com", displayName: "Original" });
    const noName = await recordAccessRequest(db, { email: "dn@acme.com" });
    expect(noName.displayName).toBe("Original");
    const withName = await recordAccessRequest(db, { email: "dn@acme.com", displayName: "Updated" });
    expect(withName.displayName).toBe("Updated");
  });

  it("normalizes email to lowercase on the PK", async () => {
    await recordAccessRequest(db, { email: "Case@Acme.com" });
    const again = await recordAccessRequest(db, { email: "case@acme.com" });
    expect(again.email).toBe("case@acme.com");
    expect(again.attemptCount).toBe(2);
  });

  it("lists by status, most-recently-seen first", async () => {
    await recordAccessRequest(db, { email: "p1@acme.com" });
    await new Promise((r) => setTimeout(r, 5));
    await recordAccessRequest(db, { email: "p2@acme.com" });
    await setAccessRequestStatus(db, { email: "p1@acme.com", status: "APPROVED" });

    const pending = await listAccessRequests(db, { status: "PENDING" });
    expect(pending.map((r) => r.email)).toEqual(["p2@acme.com"]);

    const approved = await listAccessRequests(db, { status: "APPROVED" });
    expect(approved.map((r) => r.email)).toEqual(["p1@acme.com"]);

    const all = await listAccessRequests(db);
    expect(all).toHaveLength(2);
    // p2 seen after p1, so it sorts first (desc last_seen).
    expect(all[0]!.email).toBe("p2@acme.com");
  });

  it("setAccessRequestStatus returns null for a missing email", async () => {
    expect(await setAccessRequestStatus(db, { email: "ghost@acme.com", status: "APPROVED" })).toBeNull();
  });
});
