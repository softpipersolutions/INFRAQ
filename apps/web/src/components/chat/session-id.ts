"use client";

/**
 * Chat session id: a client-generated UUID, stable per conversation. Persisted
 * in sessionStorage (per-tab) so a page refresh resumes the same conversation
 * with the server-side chat_sessions/slot_state row, while a new tab (or
 * "Start over") begins a fresh one.
 */
const STORAGE_KEY = "pebble.chat.sessionId";

export function getOrCreateSessionId(): string {
  const existing = window.sessionStorage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const next = crypto.randomUUID();
  window.sessionStorage.setItem(STORAGE_KEY, next);
  return next;
}

/** Mint and persist a brand-new session id (used by "Start over"). */
export function resetSessionId(): string {
  const next = crypto.randomUUID();
  window.sessionStorage.setItem(STORAGE_KEY, next);
  return next;
}
