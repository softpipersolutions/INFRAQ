-- Phase C.5 agentic chat layer — additive columns for running-summary
-- compaction, contradiction escalation, and tool/receipt part persistence on
-- chat history. Applied after 0002 by src/migrate.ts. Runs identically on
-- Cloud SQL Postgres 16 and the PGlite dev/test driver (verified: a single
-- multi-clause ALTER TABLE ... ADD COLUMN IF NOT EXISTS applies and re-applies
-- cleanly on PGlite, so it is not split into per-column statements).
--
-- chat_sessions.summary / summary_upto_message_id back the Gemini-Flash
-- running-summary refresh (watermarked by message id — ULIDs sort
-- chronologically, so `id > summary_upto_message_id` selects the unsummarized
-- tail). chat_sessions.contradictions is a persisted counter feeding the
-- Opus escalation guard (>=2 confirmed-slot contradictions). All three are
-- nullable/defaulted so existing sessions keep working unchanged.
--
-- chat_messages.parts is nullable jsonb for tool-call/tool-result/receipt
-- parts (reload fidelity for the chat UI's activity rows); legacy rows stay
-- text-only with parts NULL.
--
-- idx_chat_messages_session_id speeds the per-session history read
-- (listChatMessages orders by id within a session) now that parts widens the
-- row.

ALTER TABLE "chat_sessions"
  ADD COLUMN IF NOT EXISTS "summary" text,
  ADD COLUMN IF NOT EXISTS "summary_upto_message_id" text,
  ADD COLUMN IF NOT EXISTS "contradictions" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "parts" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_messages_session_id" ON "chat_messages" ("session_id","id");
