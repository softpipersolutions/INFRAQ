import "server-only";

import {
  buildMemoryHandler,
  DEFAULT_MEMORY_CAPS,
  type MemoryCaps,
  type MemoryHandler,
  type MemoryStore,
} from "@pebble/ai";
import {
  deleteMemoryFile,
  getMemoryFile,
  listMemoryFiles,
  renameMemoryFile,
  upsertMemoryFile,
  type Db,
} from "@pebble/db";

/**
 * The per-user `MemoryStore` (WP9) implemented over the owner-scoped memory repo
 * with the authenticated `userId` PRE-BOUND. Every method AND's the user in via
 * the repo, so a handler built from this store can only ever touch its own
 * user's memory — the model never sees, and cannot cross, a user boundary.
 *
 * `buildBoundMemoryHandler` composes the store into `@pebble/ai`'s
 * `buildMemoryHandler` (which owns path safety + the caps), returning the
 * `execute`-ready handler the memory toolset delegates to.
 */
export function createMemoryStore(db: Db, userId: string): MemoryStore {
  return {
    async get(path) {
      const row = await getMemoryFile(db, { userId, path });
      return row ? { path: row.path, content: row.content, sizeBytes: row.sizeBytes } : null;
    },
    async list() {
      const rows = await listMemoryFiles(db, userId);
      return rows.map((r) => ({ path: r.path, sizeBytes: r.sizeBytes }));
    },
    async upsert(path, content) {
      await upsertMemoryFile(db, { userId, path, content });
    },
    async remove(path) {
      return deleteMemoryFile(db, { userId, path });
    },
    async rename(oldPath, newPath) {
      return renameMemoryFile(db, { userId, oldPath, newPath });
    },
  };
}

/** Build the userId-bound memory handler the memory toolset's `execute` delegates to. */
export function buildBoundMemoryHandler(
  db: Db,
  userId: string,
  caps: MemoryCaps = DEFAULT_MEMORY_CAPS,
): MemoryHandler {
  return buildMemoryHandler({ store: createMemoryStore(db, userId), caps });
}
