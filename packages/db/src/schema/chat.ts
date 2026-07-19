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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
