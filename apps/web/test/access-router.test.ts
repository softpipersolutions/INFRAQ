import {
  createDb,
  isEmailInDbAllowlist,
  listAccessRequests,
  listAllowedEmails,
  migrateDb,
  recordAccessRequest,
  seedDatabase,
  setAllowedEmailActive,
  upsertAllowedEmail,
  type AppUser,
  type Db,
  type DbHandle,
} from "@pebble/db";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isEmailAllowedByEnv,
  isEmailAllowedForApp,
  parseEnvAllowlist,
} from "../src/server/auth";
import { appRouter } from "../src/server/routers/_app";
import { createCallerFactory, type Ctx } from "../src/server/trpc";

/**
 * In-app allowlist management: the auth UNION logic (env + DB allowlist, fail
 * closed), the deny→record path the session-mint route runs, and the access
 * router's admin-only RBAC + approve integration.
 */

const createCaller = createCallerFactory(appRouter);

function userWith(role: AppUser["role"]): AppUser {
  return {
    firebaseUid: `test-${role}`,
    email: `${role}@greenberg.test`,
    displayName: `Test ${role}`,
    role,
    active: true,
  };
}

async function code(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof TRPCError) return err.code;
    throw err;
  }
}

describe("allowlist union logic (fail closed)", () => {
  let handle: DbHandle;
  let db: Db;

  beforeAll(async () => {
    handle = await createDb({ pglite: true, pgliteDir: "memory://" });
    await migrateDb(handle);
    db = handle.db as unknown as Db;
  });
  afterAll(async () => {
    await handle.close();
  });

  it("env-only: allowed by PEBBLE_ALLOWED_EMAILS / PEBBLE_ALLOWED_DOMAIN", () => {
    const env = { PEBBLE_ALLOWED_EMAILS: "boss@greenberg.com", PEBBLE_ALLOWED_DOMAIN: "greenberg.com" };
    expect(isEmailAllowedByEnv("boss@greenberg.com", env)).toBe(true);
    expect(isEmailAllowedByEnv("anyone@greenberg.com", env)).toBe(true); // domain match
    expect(isEmailAllowedByEnv("stranger@other.com", env)).toBe(false);
    // Case-insensitive.
    expect(isEmailAllowedByEnv("BOSS@GREENBERG.COM", env)).toBe(true);
  });

  it("both empty → deny (fail closed)", async () => {
    const env = {};
    expect(isEmailAllowedByEnv("someone@acme.com", env)).toBe(false);
    expect(await isEmailAllowedForApp(db, "someone@acme.com", env)).toBe(false);
  });

  it("db-only: an active allowed_emails row grants access with an empty env", async () => {
    const env = {};
    await upsertAllowedEmail(db, { email: "dbonly@acme.com", addedBy: "admin@greenberg.test" });
    expect(await isEmailAllowedForApp(db, "dbonly@acme.com", env)).toBe(true);
  });

  it("deactivated db row → deny (fails closed on the next request)", async () => {
    const env = {};
    await upsertAllowedEmail(db, { email: "gone@acme.com", addedBy: "admin@greenberg.test" });
    expect(await isEmailAllowedForApp(db, "gone@acme.com", env)).toBe(true);
    await setAllowedEmailActive(db, { email: "gone@acme.com", active: false });
    expect(await isEmailAllowedForApp(db, "gone@acme.com", env)).toBe(false);
  });

  it("env union db: env match wins even without a db row", async () => {
    const env = { PEBBLE_ALLOWED_EMAILS: "envwin@acme.com" };
    expect(await isEmailAllowedForApp(db, "envwin@acme.com", env)).toBe(true);
  });

  it("parseEnvAllowlist normalizes the env into emails + domain", () => {
    const parsed = parseEnvAllowlist({
      PEBBLE_ALLOWED_EMAILS: " A@x.com, b@y.com ,",
      PEBBLE_ALLOWED_DOMAIN: "Greenberg.COM",
    });
    expect(parsed.emails).toEqual(["a@x.com", "b@y.com"]);
    expect(parsed.domain).toBe("greenberg.com");
  });
});

describe("session-mint deny path (helper + repo composition)", () => {
  // The POST /api/auth/session handler itself is not unit-tested here: it
  // requires Firebase ID-token verification (verifyIdToken → Admin SDK / ADC),
  // and there is no existing mock harness for the mint route. This exercises the
  // exact sequence the route runs on a denied sign-in — the union check returns
  // false, then recordAccessRequest logs a PENDING request BEFORE the 403.
  let handle: DbHandle;
  let db: Db;
  beforeAll(async () => {
    handle = await createDb({ pglite: true, pgliteDir: "memory://" });
    await migrateDb(handle);
    db = handle.db as unknown as Db;
  });
  afterAll(async () => {
    await handle.close();
  });

  it("a denied email is logged as a PENDING access request", async () => {
    const env = {};
    const email = "denied@acme.com";
    expect(await isEmailAllowedForApp(db, email, env)).toBe(false);
    await recordAccessRequest(db, { email, displayName: "Denied Person" });

    const pending = await listAccessRequests(db, { status: "PENDING" });
    const row = pending.find((r) => r.email === email);
    expect(row).toBeDefined();
    expect(row!.displayName).toBe("Denied Person");
    expect(row!.attemptCount).toBe(1);
  });
});

describe("access router RBAC + approval flow", () => {
  let handle: DbHandle;
  let db: Db;

  beforeAll(async () => {
    handle = await createDb({ pglite: true, pgliteDir: "memory://" });
    await migrateDb(handle);
    await seedDatabase(handle.db);
    db = handle.db as unknown as Db;
  });
  afterAll(async () => {
    await handle.close();
  });

  function callerFor(user: Ctx["user"]) {
    return createCaller({ db, user });
  }

  it("estimator and approver are FORBIDDEN on every access procedure", async () => {
    for (const role of ["estimator", "approver"] as const) {
      const caller = callerFor(userWith(role));
      expect(await code(caller.access.requests())).toBe("FORBIDDEN");
      expect(await code(caller.access.pendingCount())).toBe("FORBIDDEN");
      expect(await code(caller.access.allowed())).toBe("FORBIDDEN");
      expect(await code(caller.access.envConfig())).toBe("FORBIDDEN");
      expect(await code(caller.access.approve({ email: "x@acme.com" }))).toBe("FORBIDDEN");
      expect(await code(caller.access.deny({ email: "x@acme.com" }))).toBe("FORBIDDEN");
      expect(await code(caller.access.addEmail({ email: "x@acme.com" }))).toBe("FORBIDDEN");
      expect(await code(caller.access.setActive({ email: "x@acme.com", active: false }))).toBe(
        "FORBIDDEN",
      );
    }
  });

  it("unauthenticated caller is UNAUTHORIZED", async () => {
    expect(await code(callerFor(null).access.requests())).toBe("UNAUTHORIZED");
  });

  it("admin approve: allowlists the email (active) AND stamps the request APPROVED", async () => {
    const admin = callerFor(userWith("admin"));
    // A denied sign-in was logged.
    await recordAccessRequest(db, { email: "hopeful@acme.com", displayName: "Hopeful" });
    expect(await isEmailInDbAllowlist(db, "hopeful@acme.com")).toBe(false);

    await admin.access.approve({ email: "hopeful@acme.com" });

    // Now allowed at the auth layer with an empty env (fail-closed union passes).
    expect(await isEmailAllowedForApp(db, "hopeful@acme.com", {})).toBe(true);
    expect(await isEmailInDbAllowlist(db, "hopeful@acme.com")).toBe(true);

    // The request row is APPROVED and off the pending list.
    const approved = await admin.access.requests({ status: "APPROVED" });
    expect(approved.map((r) => r.email)).toContain("hopeful@acme.com");
    const pending = await admin.access.requests({ status: "PENDING" });
    expect(pending.map((r) => r.email)).not.toContain("hopeful@acme.com");

    // addedBy is stamped with the approving admin's email.
    const allowed = await listAllowedEmails(db);
    expect(allowed.find((r) => r.email === "hopeful@acme.com")?.addedBy).toBe("admin@greenberg.test");
  });

  it("admin can re-approve a previously DENIED request (flip it back)", async () => {
    const admin = callerFor(userWith("admin"));
    await recordAccessRequest(db, { email: "second@acme.com" });
    await admin.access.deny({ email: "second@acme.com" });
    let denied = await admin.access.requests({ status: "DENIED" });
    expect(denied.map((r) => r.email)).toContain("second@acme.com");
    // A re-attempt while denied does NOT reopen it.
    await recordAccessRequest(db, { email: "second@acme.com" });
    denied = await admin.access.requests({ status: "DENIED" });
    expect(denied.map((r) => r.email)).toContain("second@acme.com");

    // Admin flips it: approve works from the denied state.
    await admin.access.approve({ email: "second@acme.com" });
    expect(await isEmailAllowedForApp(db, "second@acme.com", {})).toBe(true);
    const approved = await admin.access.requests({ status: "APPROVED" });
    expect(approved.map((r) => r.email)).toContain("second@acme.com");
  });

  it("admin addEmail proactively allowlists, setActive toggles it, pendingCount reflects PENDING", async () => {
    const admin = callerFor(userWith("admin"));
    await admin.access.addEmail({ email: "Proactive@Acme.com", note: "new hire" });
    expect(await isEmailInDbAllowlist(db, "proactive@acme.com")).toBe(true);

    await admin.access.setActive({ email: "proactive@acme.com", active: false });
    expect(await isEmailInDbAllowlist(db, "proactive@acme.com")).toBe(false);

    // pendingCount matches the PENDING request list length.
    const pending = await admin.access.requests({ status: "PENDING" });
    expect(await admin.access.pendingCount()).toBe(pending.length);
  });

  it("admin envConfig returns the parsed deploy-baked allowlist", async () => {
    const admin = callerFor(userWith("admin"));
    const cfg = await admin.access.envConfig();
    expect(cfg).toHaveProperty("emails");
    expect(cfg).toHaveProperty("domain");
  });
});
