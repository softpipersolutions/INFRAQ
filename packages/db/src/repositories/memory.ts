import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { memoryFiles } from "../schema";

/**
 * Cross-session agent-memory repository (Chat overhaul WP9) — the durable store
 * behind the Claude memory tool.
 *
 * USER SCOPING (security): the table's primary key is (user_id, path), so every
 * function here is keyed by BOTH — a memory file is only ever addressable with
 * its owner's id. There is no "by path alone" read: a caller that passes a
 * foreign `userId` simply matches zero rows (a read returns `null`, a delete
 * reports `false`). The memory HANDLER owns path safety (the /memories/ prefix,
 * traversal rejection) and the per-user caps BEFORE any of these run; this layer
 * takes already-validated paths and just persists them.
 *
 * House style: `db` first so these compose inside a `db.transaction`. `sizeBytes`
 * is the UTF-8 byte length of `content`, computed here on every write so the
 * caps + inspection UI never recompute it.
 */

export interface MemoryFileRow {
  userId: string;
  /** Normalized, /memories/-prefixed virtual path. */
  path: string;
  content: string;
  /** UTF-8 byte length of `content`. */
  sizeBytes: number;
  updatedAt: Date;
}

function rowToMemoryFile(r: typeof memoryFiles.$inferSelect): MemoryFileRow {
  return {
    userId: r.userId,
    path: r.path,
    content: r.content,
    sizeBytes: r.sizeBytes,
    updatedAt: r.updatedAt,
  };
}

/** UTF-8 byte length of a string (the stored `size_bytes`). */
export function memoryByteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

/**
 * One memory file by (userId, path), or `null` when it does not exist for that
 * user. Keyed by both columns, so a foreign `userId` never reads another user's
 * file.
 */
export async function getMemoryFile(
  db: Db,
  args: { userId: string; path: string },
): Promise<MemoryFileRow | null> {
  const rows = await db
    .select()
    .from(memoryFiles)
    .where(and(eq(memoryFiles.userId, args.userId), eq(memoryFiles.path, args.path)))
    .limit(1);
  const r = rows[0];
  return r ? rowToMemoryFile(r) : null;
}

/**
 * Every memory file for a user, path-ascending (a stable order for the tool's
 * directory listing and the inspection UI). Owner-scoped: only ever `userId`'s
 * own files.
 */
export async function listMemoryFiles(db: Db, userId: string): Promise<MemoryFileRow[]> {
  const rows = await db
    .select()
    .from(memoryFiles)
    .where(eq(memoryFiles.userId, userId))
    .orderBy(asc(memoryFiles.path));
  return rows.map(rowToMemoryFile);
}

/**
 * Create-or-overwrite a memory file (upsert on the (user_id, path) primary key).
 * `size_bytes` and `updated_at` are recomputed on every write. Returns the
 * persisted row.
 */
export async function upsertMemoryFile(
  db: Db,
  args: { userId: string; path: string; content: string },
): Promise<MemoryFileRow> {
  const sizeBytes = memoryByteLength(args.content);
  const updatedAt = new Date();
  await db
    .insert(memoryFiles)
    .values({ userId: args.userId, path: args.path, content: args.content, sizeBytes, updatedAt })
    .onConflictDoUpdate({
      target: [memoryFiles.userId, memoryFiles.path],
      set: { content: args.content, sizeBytes, updatedAt },
    });
  return { userId: args.userId, path: args.path, content: args.content, sizeBytes, updatedAt };
}

/**
 * Delete a memory file. Returns `true` when a row was removed, `false` when
 * there was nothing to delete (missing path, or a foreign `userId`).
 */
export async function deleteMemoryFile(
  db: Db,
  args: { userId: string; path: string },
): Promise<boolean> {
  const deleted = await db
    .delete(memoryFiles)
    .where(and(eq(memoryFiles.userId, args.userId), eq(memoryFiles.path, args.path)))
    .returning({ path: memoryFiles.path });
  return deleted.length > 0;
}

/**
 * Move a memory file from `oldPath` to `newPath` for a user, preserving its
 * content. A no-op returning `false` when `oldPath` does not exist for that
 * user; otherwise the content is upserted at `newPath` (overwriting any file
 * already there) and the old row removed, in a single transaction. `oldPath ===
 * newPath` short-circuits to `true` (nothing to move). Owner-scoped throughout.
 */
export async function renameMemoryFile(
  db: Db,
  args: { userId: string; oldPath: string; newPath: string },
): Promise<boolean> {
  if (args.oldPath === args.newPath) {
    const existing = await getMemoryFile(db, { userId: args.userId, path: args.oldPath });
    return existing !== null;
  }
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const old = await getMemoryFile(txDb, { userId: args.userId, path: args.oldPath });
    if (!old) return false;
    await upsertMemoryFile(txDb, { userId: args.userId, path: args.newPath, content: old.content });
    await deleteMemoryFile(txDb, { userId: args.userId, path: args.oldPath });
    return true;
  });
}
