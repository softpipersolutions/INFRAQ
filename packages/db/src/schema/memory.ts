import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Cross-session agent memory (Chat overhaul WP9) — one row per durable memory
 * FILE the Claude memory tool writes, scoped to the user who owns the chat.
 *
 * The composite primary key (user_id, path) makes this store user-scoped BY
 * CONSTRUCTION: a memory file is only ever addressable with its owner's id, so
 * no repo read/write can reach across users. `path` holds the normalized,
 * prefix-validated virtual path verbatim (e.g. /memories/preferences.md); the
 * memory handler owns path safety + the per-user caps before anything lands
 * here. `size_bytes` is the UTF-8 byte length of `content`, maintained by the
 * repo on every upsert. There is intentionally NO foreign key on user_id (see
 * drizzle/0006_memory_files.sql for why).
 */
export const memoryFiles = pgTable(
  "memory_files",
  {
    userId: text("user_id").notNull(),
    /** Normalized, /memories/-prefixed virtual path (the handler guarantees the shape). */
    path: text("path").notNull(),
    content: text("content").notNull(),
    /** UTF-8 byte length of `content`; maintained by the repo, read by the caps + UI. */
    sizeBytes: integer("size_bytes").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.path] })],
);
