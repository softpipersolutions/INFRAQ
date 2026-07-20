-- Chat overhaul WP1 — session-list denormalization + cache-token ledger
-- columns. Applied after 0003 by src/migrate.ts. Runs identically on Cloud SQL
-- Postgres 16 and the PGlite dev/test driver (verified: a single multi-clause
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS applies and re-applies cleanly on
-- PGlite, so it is not split into per-column statements).
--
-- chat_sessions gains the fields the (next-WP) session list reads without a
-- join into chat_messages:
--   title                 — user/agent-set label; NO backfill, so legacy rows
--                           read NULL and the list renders a fallback.
--   archived_at/pinned_at — nullable timestamps used as soft flags (NULL = not
--                           archived / not pinned).
--   last_message_at       — denormalized newest-message time; the list's sort
--                           key. Maintained by appendChatMessage.
--   last_message_preview  — first 120 chars of the newest message. Maintained
--                           by appendChatMessage.
-- All nullable so existing sessions keep working unchanged.
--
-- llm_calls gains cache_read_tokens / cache_write_tokens (nullable integers)
-- surfacing Anthropic prompt-cache usage on the ledger row for the cost
-- dashboard. cost_usd remains the budget source of truth; these two are
-- reporting-only and legacy rows stay NULL.
--
-- idx_chat_sessions_user_activity backs the session list's primary read — a
-- user's sessions, active split from archived, newest-active first
-- (user_id, archived_at, last_message_at DESC).
--
-- Backfill: seed last_message_at from updated_at so pre-existing sessions sort
-- sensibly on first render. No title backfill (legacy rows render a fallback).

ALTER TABLE "chat_sessions"
  ADD COLUMN IF NOT EXISTS "title" text,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "pinned_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "last_message_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "last_message_preview" text;--> statement-breakpoint
ALTER TABLE "llm_calls"
  ADD COLUMN IF NOT EXISTS "cache_read_tokens" integer,
  ADD COLUMN IF NOT EXISTS "cache_write_tokens" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_sessions_user_activity" ON "chat_sessions" ("user_id","archived_at","last_message_at" DESC);--> statement-breakpoint
UPDATE "chat_sessions" SET "last_message_at" = "updated_at" WHERE "last_message_at" IS NULL;
