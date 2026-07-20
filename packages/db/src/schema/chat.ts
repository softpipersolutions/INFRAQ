import { integer, jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Conversational enquiry capture (chat lane) + LLM cost accounting.
 * chat_sessions.enquiry_id is intentionally NOT a foreign key: the enquiry is
 * created from the session (and enquiries.chat_session_id points back), so a
 * hard FK either way would be circular.
 */
export const chatSessions = pgTable("chat_sessions", {
  id: text("id").primaryKey(), // ULID
  userId: text("user_id")
    .notNull()
    .references(() => users.firebaseUid),
  /** Slot-filling state for enquiry capture (partial A.08 fields). */
  slotState: jsonb("slot_state").$type<Record<string, unknown>>().notNull(),
  enquiryId: text("enquiry_id"),
  /** Gemini-Flash-maintained running summary of turns older than the window. */
  summary: text("summary"),
  /** ULID watermark: `summary` covers messages with id <= this. Null = no summary yet. */
  summaryUptoMessageId: text("summary_upto_message_id"),
  /** Confirmed-slot contradiction counter — feeds the Opus escalation guard. */
  contradictions: integer("contradictions").notNull().default(0),
  /** User/agent-set session label; null on legacy rows (list renders a fallback). */
  title: text("title"),
  /** Soft-archive flag: null = active, timestamp = archived at that instant. */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  /** Pin flag: null = unpinned, timestamp = pinned at that instant. */
  pinnedAt: timestamp("pinned_at", { withTimezone: true }),
  /** Denormalized newest-message time — the session list's sort key (see appendChatMessage). */
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  /** First 120 chars of the newest message — the session list preview (see appendChatMessage). */
  lastMessagePreview: text("last_message_preview"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: text("id").primaryKey(), // ULID
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSessions.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  lane: text("lane"),
  model: text("model"),
  /** Tool-call/tool-result/receipt parts for reload fidelity; null for legacy text-only rows. */
  parts: jsonb("parts").$type<unknown[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per uploaded chat attachment (Chat overhaul WP7) — one row per
 * upload, not per distinct file (see drizzle/0005_chat_attachments.sql for
 * why). `status` is 'READY' for types the agent can read directly, or
 * 'OFFICE_PENDING' for xlsx/docx pending the skills-lane conversion.
 */
export const chatAttachments = pgTable("chat_attachments", {
  id: text("id").primaryKey(), // ULID
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSessions.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.firebaseUid),
  filename: text("filename").notNull(),
  mediaType: text("media_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  storageUri: text("storage_uri").notNull(),
  /** Set for PDFs only — the upload route's >100-page guard reads this before insert. */
  pageCount: integer("page_count"),
  status: text("status").notNull().default("READY"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per LLM API call — cost/latency accounting across lanes. */
export const llmCalls = pgTable("llm_calls", {
  id: text("id").primaryKey(), // ULID
  sessionId: text("session_id"),
  lane: text("lane").notNull(),
  model: text("model").notNull(),
  intent: text("intent"),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  /** Anthropic prompt-cache reads on this call (reporting-only; cost_usd already prices them). */
  cacheReadTokens: integer("cache_read_tokens"),
  /** Anthropic prompt-cache writes on this call (reporting-only; cost_usd already prices them). */
  cacheWriteTokens: integer("cache_write_tokens"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
