-- Chat overhaul WP7 — file-upload attachments table for the Pebble chat
-- composer. Applied after 0004 by src/migrate.ts. Runs identically on Cloud
-- SQL Postgres 16 and the PGlite dev/test driver (CREATE TABLE IF NOT EXISTS +
-- CREATE INDEX IF NOT EXISTS throughout, so a re-run is a clean no-op — same
-- idempotency style as 0004).
--
-- chat_attachments is one row per UPLOAD (session, user, file), not one row
-- per distinct file: the same bytes attached twice (same session or two
-- different sessions) get two rows, each pointing at the SAME storage_uri
-- once the (user_id, sha256) dedup in the upload route finds the earlier
-- upload — so "attachments for this session" stays a simple row scan even
-- though the object itself is written to storage once per user.
--
-- status: 'READY' for types the agent can read directly (PDF, images, plain
-- text/markdown/csv); 'OFFICE_PENDING' for xlsx/docx, which a later WP's
-- skills lane converts before the agent can read them. page_count is set for
-- PDFs only (the upload route's >100-page guard reads it before insert).
--
-- idx_chat_attachments_session backs "attachments for this session" (the
-- composer's pending-list hydration and, from WP8, the per-turn attachment
-- lookup) — session_id first, id second so a session's rows come back in
-- upload (chronological ULID) order.
-- idx_chat_attachments_user_sha256 backs the per-user dedup-by-content lookup
-- the upload route runs before writing to storage.

CREATE TABLE IF NOT EXISTS "chat_attachments" (
  "id" text PRIMARY KEY,
  "session_id" text NOT NULL REFERENCES "chat_sessions"("id"),
  "user_id" text NOT NULL REFERENCES "users"("firebase_uid"),
  "filename" text NOT NULL,
  "media_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "sha256" text NOT NULL,
  "storage_uri" text NOT NULL,
  "page_count" integer,
  "status" text NOT NULL DEFAULT 'READY',
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_attachments_session" ON "chat_attachments" ("session_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_attachments_user_sha256" ON "chat_attachments" ("user_id","sha256");
