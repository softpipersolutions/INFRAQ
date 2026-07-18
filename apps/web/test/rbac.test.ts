import { createDb, migrateDb, seedDatabase, type AppUser, type Db, type DbHandle } from "@pebble/db";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "../src/server/routers/_app";
import { createCallerFactory, type Ctx } from "../src/server/trpc";

/**
 * RBAC gates on the tRPC routers, exercised via createCaller with fabricated
 * users — no cookies/Firebase involved (that path is covered by auth.ts and is
 * mode-gated). Asserts the FORBIDDEN wall itself, plus that an authorised role
 * gets PAST the wall (failing later on business logic, not on auth).
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

describe("router RBAC", () => {
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

  it("blocks unauthenticated callers with UNAUTHORIZED", async () => {
    const caller = callerFor(null);
    expect(await code(caller.dashboard.stats())).toBe("UNAUTHORIZED");
    expect(await code(caller.estimate.approve({ estimateId: "nope" }))).toBe("UNAUTHORIZED");
  });

  it("estimator: reads pass, admin/approver mutations are FORBIDDEN", async () => {
    const caller = callerFor(userWith("estimator"));

    // Reads and non-privileged procedures work.
    const stats = await caller.dashboard.stats();
    expect(stats.enquiryCount).toBeGreaterThanOrEqual(0);

    // Masters mutations are admin-only.
    expect(
      await code(
        caller.masters.createMaterial({
          materialCode: "TEST-MAT-001",
          materialName: "Test material",
          systemType: "FAS",
          category: "Detector",
          unitOfMeasure: "No.",
          active: true,
        }),
      ),
    ).toBe("FORBIDDEN");

    // Approval is approver-only.
    expect(await code(caller.estimate.approve({ estimateId: "nope" }))).toBe("FORBIDDEN");
  });

  it("approver: passes the approve gate (fails on business logic, not auth)", async () => {
    const caller = callerFor(userWith("approver"));
    const result = await code(caller.estimate.approve({ estimateId: "does-not-exist" }));
    expect(result).not.toBe("FORBIDDEN");
    expect(result).toBe("NOT_FOUND");
  });

  it("admin: passes every role gate", async () => {
    const caller = callerFor(userWith("admin"));

    // roleProcedure("approver") admits admin — NOT_FOUND proves we got past auth.
    expect(await code(caller.estimate.approve({ estimateId: "does-not-exist" }))).toBe("NOT_FOUND");

    // roleProcedure("admin") mutation actually runs.
    const created = await caller.masters.createMaterial({
      materialCode: "TEST-MAT-002",
      materialName: "Admin-created material",
      systemType: "FAS",
      category: "Detector",
      unitOfMeasure: "No.",
      active: true,
    });
    expect(created).toEqual({ ok: true });

    // users.setRole is admin-only and requires an existing row.
    expect(
      await code(caller.users.setRole({ firebaseUid: "missing-user", role: "approver" })),
    ).toBe("NOT_FOUND");
  });
});
