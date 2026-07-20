-- Chat overhaul WP9 — cross-session memory store for the Pebble chat. Applied
-- after 0005 by src/migrate.ts. Runs identically on Cloud SQL Postgres 16 and
-- the PGlite dev/test driver (CREATE TABLE IF NOT EXISTS, so a re-run is a clean
-- no-op — same idempotency style as 0004/0005).
--
-- memory_files backs the Claude "memory" tool (provider-defined
-- memory_20250818): one row per durable memory FILE the agent writes, scoped to
-- the user who owns the conversation. The tool's own path space is a virtual
-- /memories/ tree; `path` stores the normalized, prefix-validated path verbatim
-- (e.g. /memories/preferences.md) and (user_id, path) is the primary key so the
-- store is user-scoped BY CONSTRUCTION — a memory file is only ever addressable
-- with its owner's id, and no index or join can reach across users.
--
-- content is the whole file (the agent keeps files small; the handler caps each
-- at 4 KB, 20 files, 64 KB total per user). size_bytes is the UTF-8 byte length
-- of `content`, maintained by the repo on every upsert so the inspection UI and
-- the cap checks read it without recomputing. updated_at is the last write time
-- (the inspection UI's "updated" column and sort hint).
--
-- Deliberately NO foreign key on user_id (unlike chat_attachments): the memory
-- store is a standalone per-user key space that must never fail a write because
-- of user-table timing, and it is only ever written through the owner-bound
-- repos + handler, so referential integrity is enforced by construction rather
-- than a constraint.

CREATE TABLE IF NOT EXISTS "memory_files" (
  "user_id" text NOT NULL,
  "path" text NOT NULL,
  "content" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "path")
);
