import {
  createDb,
  migrateDb,
  seedDatabase,
  upsertMemoryFile,
  upsertUser,
  type AppUser,
  type Db,
  type DbHandle,
} from "@pebble/db";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "../src/server/routers/_app";
import { createCallerFactory, type Ctx } from "../src/server/trpc";

/**
 * Memory router (WP9): owner-scoping over an in-memory PGlite db. A user only
 * ever lists / reads / deletes their OWN memory; a foreign path is NOT_FOUND on
 * read and a no-op on delete, admins included.
 */

const createCaller = createCallerFactory(appRouter);

const USER_A: AppUser = {
  firebaseUid: "mem-a",
  email: "mem-a@greenberg.test",
  displayName: "Mem A",
  role: "estimator",
  active: true,
};
const USER_B: AppUser = {
  firebaseUid: "mem-b",
  email: "mem-b@greenberg.test",
  displayName: "Mem B",
  role: "estimator",
  active: true,
};
const ADMIN: AppUser = {
  firebaseUid: "mem-admin",
  email: "mem-admin@greenberg.test",
  displayName: "Mem Admin",
  role: "admin",
  active: true,
};

describe("memory router", () => {
  let handle: DbHandle;
  let db: Db;

  beforeAll(async () => {
    handle = await createDb({ pglite: true, pgliteDir: "memory://" });
    await migrateDb(handle);
    await seedDatabase(handle.db);
    db = handle.db as unknown as Db;
    await upsertUser(db, USER_A);
    await upsertUser(db, USER_B);
    await upsertUser(db, ADMIN);
    await upsertMemoryFile(db, { userId: USER_A.firebaseUid, path: "/memories/a-pref.md", content: "A prefers Agni" });
    await upsertMemoryFile(db, { userId: USER_B.firebaseUid, path: "/memories/b-pref.md", content: "B prefers Ravel" });
  });

  afterAll(async () => {
    await handle.close();
  });

  function callerFor(user: Ctx["user"]) {
    return createCaller({ db, user });
  }

  it("unauthenticated caller is UNAUTHORIZED", async () => {
    let code: string | null = null;
    try {
      await callerFor(null).memory.list();
    } catch (err) {
      if (err instanceof TRPCError) code = err.code;
      else throw err;
    }
    expect(code).toBe("UNAUTHORIZED");
  });

  it("list returns only the caller's own files", async () => {
    const a = await callerFor(USER_A).memory.list();
    expect(a.map((f) => f.path)).toEqual(["/memories/a-pref.md"]);
    expect(a[0]!.sizeBytes).toBeGreaterThan(0);

    const b = await callerFor(USER_B).memory.list();
    expect(b.map((f) => f.path)).toEqual(["/memories/b-pref.md"]);
  });

  it("get returns the caller's own file content", async () => {
    const got = await callerFor(USER_A).memory.get({ path: "/memories/a-pref.md" });
    expect(got.content).toBe("A prefers Agni");
  });

  it("get on another user's path is NOT_FOUND (no existence leak)", async () => {
    let code: string | null = null;
    try {
      await callerFor(USER_A).memory.get({ path: "/memories/b-pref.md" });
    } catch (err) {
      if (err instanceof TRPCError) code = err.code;
      else throw err;
    }
    expect(code).toBe("NOT_FOUND");
  });

  it("an admin cannot read another user's memory (strict owner-only)", async () => {
    let code: string | null = null;
    try {
      await callerFor(ADMIN).memory.get({ path: "/memories/a-pref.md" });
    } catch (err) {
      if (err instanceof TRPCError) code = err.code;
      else throw err;
    }
    expect(code).toBe("NOT_FOUND");
  });

  it("delete of a foreign path is a no-op (deleted:false) and leaves it intact", async () => {
    const res = await callerFor(USER_A).memory.delete({ path: "/memories/b-pref.md" });
    expect(res.deleted).toBe(false);
    // B's file survives.
    const b = await callerFor(USER_B).memory.get({ path: "/memories/b-pref.md" });
    expect(b.content).toBe("B prefers Ravel");
  });

  it("delete of an owned path removes it", async () => {
    await upsertMemoryFile(db, { userId: USER_A.firebaseUid, path: "/memories/tmp.md", content: "scratch" });
    const res = await callerFor(USER_A).memory.delete({ path: "/memories/tmp.md" });
    expect(res.deleted).toBe(true);
    let code: string | null = null;
    try {
      await callerFor(USER_A).memory.get({ path: "/memories/tmp.md" });
    } catch (err) {
      if (err instanceof TRPCError) code = err.code;
      else throw err;
    }
    expect(code).toBe("NOT_FOUND");
  });
});
