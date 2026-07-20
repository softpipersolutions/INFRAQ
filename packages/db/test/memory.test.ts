import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db, DbHandle } from "../src/index";
import {
  createDb,
  deleteMemoryFile,
  getMemoryFile,
  listMemoryFiles,
  memoryByteLength,
  migrateDb,
  renameMemoryFile,
  upsertMemoryFile,
} from "../src/index";
import { freshDb } from "./helpers";

/**
 * Cross-session memory repo (WP9). Round-trips + user isolation on the
 * (user_id, path) key space. No FK on user_id, so plain string ids are used.
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

const USER_A = "user-a";
const USER_B = "user-b";

describe("0006 memory_files migration", () => {
  it("applies 0006_memory_files.sql on a fresh database", async () => {
    const fresh = await createDb({ pglite: true, pgliteDir: "memory://" });
    try {
      const applied = await migrateDb(fresh);
      expect(applied).toContain("0006_memory_files.sql");
    } finally {
      await fresh.close();
    }
  });
});

describe("memoryByteLength", () => {
  it("measures UTF-8 bytes, not code units", () => {
    expect(memoryByteLength("abc")).toBe(3);
    expect(memoryByteLength("₹")).toBe(3); // 3-byte UTF-8
    expect(memoryByteLength("")).toBe(0);
  });
});

describe("upsert + get + list", () => {
  it("creates, reads back, and lists a memory file with its byte size", async () => {
    const row = await upsertMemoryFile(db, {
      userId: USER_A,
      path: "/memories/preferences.md",
      content: "likes Agni make",
    });
    expect(row.sizeBytes).toBe(memoryByteLength("likes Agni make"));

    const got = await getMemoryFile(db, { userId: USER_A, path: "/memories/preferences.md" });
    expect(got?.content).toBe("likes Agni make");
    expect(got?.sizeBytes).toBe(row.sizeBytes);

    const list = await listMemoryFiles(db, USER_A);
    expect(list).toHaveLength(1);
    expect(list[0]!.path).toBe("/memories/preferences.md");
  });

  it("upsert overwrites content + size (not a second row) and bumps updated_at", async () => {
    const first = await upsertMemoryFile(db, { userId: USER_A, path: "/memories/a.md", content: "short" });
    await new Promise((r) => setTimeout(r, 2));
    const second = await upsertMemoryFile(db, {
      userId: USER_A,
      path: "/memories/a.md",
      content: "a much longer body now",
    });
    const list = await listMemoryFiles(db, USER_A);
    expect(list).toHaveLength(1);
    expect(list[0]!.content).toBe("a much longer body now");
    expect(second.sizeBytes).toBeGreaterThan(first.sizeBytes);
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it("lists files path-ascending", async () => {
    await upsertMemoryFile(db, { userId: USER_A, path: "/memories/z.md", content: "z" });
    await upsertMemoryFile(db, { userId: USER_A, path: "/memories/a.md", content: "a" });
    await upsertMemoryFile(db, { userId: USER_A, path: "/memories/m.md", content: "m" });
    const list = await listMemoryFiles(db, USER_A);
    expect(list.map((f) => f.path)).toEqual(["/memories/a.md", "/memories/m.md", "/memories/z.md"]);
  });
});

describe("delete", () => {
  it("removes a file and reports true; a missing path reports false", async () => {
    await upsertMemoryFile(db, { userId: USER_A, path: "/memories/a.md", content: "a" });
    expect(await deleteMemoryFile(db, { userId: USER_A, path: "/memories/a.md" })).toBe(true);
    expect(await getMemoryFile(db, { userId: USER_A, path: "/memories/a.md" })).toBeNull();
    expect(await deleteMemoryFile(db, { userId: USER_A, path: "/memories/a.md" })).toBe(false);
  });
});

describe("rename", () => {
  it("moves content to the new path and drops the old one", async () => {
    await upsertMemoryFile(db, { userId: USER_A, path: "/memories/old.md", content: "keep me" });
    expect(
      await renameMemoryFile(db, { userId: USER_A, oldPath: "/memories/old.md", newPath: "/memories/new.md" }),
    ).toBe(true);
    expect(await getMemoryFile(db, { userId: USER_A, path: "/memories/old.md" })).toBeNull();
    const moved = await getMemoryFile(db, { userId: USER_A, path: "/memories/new.md" });
    expect(moved?.content).toBe("keep me");
  });

  it("reports false when the source path does not exist", async () => {
    expect(
      await renameMemoryFile(db, { userId: USER_A, oldPath: "/memories/none.md", newPath: "/memories/x.md" }),
    ).toBe(false);
    expect(await getMemoryFile(db, { userId: USER_A, path: "/memories/x.md" })).toBeNull();
  });

  it("same old/new path is a no-op that reports whether the file exists", async () => {
    await upsertMemoryFile(db, { userId: USER_A, path: "/memories/a.md", content: "a" });
    expect(
      await renameMemoryFile(db, { userId: USER_A, oldPath: "/memories/a.md", newPath: "/memories/a.md" }),
    ).toBe(true);
    expect(
      await renameMemoryFile(db, { userId: USER_A, oldPath: "/memories/z.md", newPath: "/memories/z.md" }),
    ).toBe(false);
  });
});

describe("user isolation (security)", () => {
  it("a file written by one user is invisible to another via get/list", async () => {
    await upsertMemoryFile(db, { userId: USER_A, path: "/memories/secret.md", content: "A's secret" });
    expect(await getMemoryFile(db, { userId: USER_B, path: "/memories/secret.md" })).toBeNull();
    expect(await listMemoryFiles(db, USER_B)).toHaveLength(0);
  });

  it("the same path is an independent row per user (no cross-user overwrite)", async () => {
    await upsertMemoryFile(db, { userId: USER_A, path: "/memories/p.md", content: "A body" });
    await upsertMemoryFile(db, { userId: USER_B, path: "/memories/p.md", content: "B body" });
    expect((await getMemoryFile(db, { userId: USER_A, path: "/memories/p.md" }))?.content).toBe("A body");
    expect((await getMemoryFile(db, { userId: USER_B, path: "/memories/p.md" }))?.content).toBe("B body");
  });

  it("one user cannot delete or rename another user's file", async () => {
    await upsertMemoryFile(db, { userId: USER_A, path: "/memories/p.md", content: "A body" });
    expect(await deleteMemoryFile(db, { userId: USER_B, path: "/memories/p.md" })).toBe(false);
    expect(
      await renameMemoryFile(db, { userId: USER_B, oldPath: "/memories/p.md", newPath: "/memories/q.md" }),
    ).toBe(false);
    // A's file is untouched.
    expect((await getMemoryFile(db, { userId: USER_A, path: "/memories/p.md" }))?.content).toBe("A body");
  });
});
