import { isFileUIPart, isTextUIPart, type UIMessage } from "ai";

/**
 * Pure, DOM-free helpers behind the chat panel's robustness UX (WP13): parsing
 * the transport error into a typed banner, the daily-budget countdown string,
 * the retry payload for a dropped turn, and the offline/retry gates. Factored
 * out of `chat-panel.tsx` so the branching logic is unit-testable without jsdom
 * (apps/web has no browser test env) — see chat-panel-helpers.test.ts.
 */

/**
 * The kind of error surfaced by `/api/chat`, driving which banner the panel
 * renders:
 *  - `budget`       — daily AI budget reached (429); a live countdown + disabled
 *                     composer, never retryable.
 *  - `unconfigured` — no model configured on the deployment (503); a setup
 *                     problem the user cannot retry away.
 *  - `interrupted`  — a mid-stream drop / transport failure with no JSON body;
 *                     retryable.
 *  - `generic`      — any other JSON error (401 sign-in, 4xx) surfaced verbatim.
 */
export type ChatErrorKind = "budget" | "unconfigured" | "interrupted" | "generic";

export interface ChatErrorInfo {
  kind: ChatErrorKind;
  /** Human-readable banner copy (unified here — the single source for these strings). */
  message: string;
  /** For `budget`: the ISO instant the daily window resets, if the server sent one. */
  resetsAtISO: string | null;
}

/** The unified copy for the two "not your fault, nothing to retry" states. */
const UNCONFIGURED_COPY = "AI is not configured — ask your admin.";
const INTERRUPTED_COPY = "The reply was interrupted.";

/**
 * Parse a `useChat` transport `Error` into a typed banner descriptor. The route
 * returns JSON on its guards (401/429/503/4xx: `{ error, message?, resetsAtISO? }`)
 * and a plain sentence on a mid-stream drop; a network failure yields a non-JSON
 * message too. Known codes get unified copy here so the strings live in ONE
 * place (WP13 §6). Returns `null` when there is no error.
 */
export function parseChatError(err: Error | null | undefined): ChatErrorInfo | null {
  if (!err) return null;

  let code: string | null = null;
  let message: string | null = null;
  let resetsAtISO: string | null = null;
  try {
    const parsed = JSON.parse(err.message) as { error?: unknown; message?: unknown; resetsAtISO?: unknown };
    if (typeof parsed?.error === "string" && parsed.error.length > 0) code = parsed.error;
    if (typeof parsed?.message === "string" && parsed.message.length > 0) message = parsed.message;
    if (typeof parsed?.resetsAtISO === "string" && parsed.resetsAtISO.length > 0) resetsAtISO = parsed.resetsAtISO;
  } catch {
    // Not JSON — a mid-stream drop or a raw network error.
  }

  if (code === "daily_budget_exceeded") {
    return { kind: "budget", message: message ?? "Daily AI budget reached.", resetsAtISO };
  }
  if (code === "model_unconfigured") {
    return { kind: "unconfigured", message: UNCONFIGURED_COPY, resetsAtISO: null };
  }
  // No JSON body (mid-stream drop / offline) → a retryable interruption.
  if (code === null && message === null) {
    return { kind: "interrupted", message: INTERRUPTED_COPY, resetsAtISO: null };
  }
  // Any other JSON guard (401 "Sign in required", 4xx) surfaced as-is.
  return { kind: "generic", message: message ?? code ?? "Something went wrong. Please try again.", resetsAtISO: null };
}

/**
 * Whether the panel should offer a Retry button for this error given whether the
 * dropped turn had already streamed any visible bytes. Retry is for a clean
 * resend of a turn that produced nothing — a `budget`/`unconfigured` error is
 * never retryable, and a turn that already streamed partial text is left as-is
 * (the partial persisted; a manual resend would duplicate it).
 */
export function shouldOfferRetry(info: ChatErrorInfo | null, streamedBytes: boolean): boolean {
  if (!info) return false;
  if (info.kind === "budget" || info.kind === "unconfigured") return false;
  return !streamedBytes;
}

/**
 * Format the remaining time to the budget reset as a compact "in 3h 24m" /
 * "in 12m" / "in 45s" string. Clamps at zero → "in 0s" (the caller re-enables
 * the composer once the instant passes and the next send re-checks the budget).
 */
export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  if (minutes > 0) return `in ${minutes}m`;
  return `in ${seconds}s`;
}

/**
 * The daily-budget banner copy with the live countdown folded in, e.g.
 * `"Daily AI budget reached — resets in 3h 24m"`. Falls back to a static
 * sentence when no reset instant was provided.
 */
export function budgetBannerText(info: ChatErrorInfo, now: number): string {
  if (!info.resetsAtISO) return "Daily AI budget reached — resets at UTC midnight.";
  const resetsAt = Date.parse(info.resetsAtISO);
  if (Number.isNaN(resetsAt)) return "Daily AI budget reached — resets at UTC midnight.";
  return `Daily AI budget reached — resets ${formatCountdown(resetsAt - now)}`;
}

/** The `attachmentId` behind a persisted/served file part url (`/api/chat/attachments/<id>`), or null. */
export function attachmentIdFromUrl(url: string | undefined | null): string | null {
  if (typeof url !== "string") return null;
  const match = /\/api\/chat\/attachments\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1]!) : null;
}

/** The resend payload for a dropped turn: the last user message's text + any attachment ids. */
export interface RetryPayload {
  text: string;
  attachmentIds: string[];
}

/**
 * Derive the retry payload from the message list: the text + attachment ids of
 * the most recent user message. Returns `null` when there is no user message to
 * resend, or when it carries no text (nothing to send).
 */
export function retryPayloadFromMessages(messages: readonly UIMessage[]): RetryPayload | null {
  let lastUser: UIMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUser = messages[i];
      break;
    }
  }
  if (!lastUser) return null;
  const text = lastUser.parts.filter(isTextUIPart).map((p) => p.text).join("").trim();
  if (!text) return null;
  const attachmentIds = lastUser.parts
    .filter(isFileUIPart)
    .map((p) => attachmentIdFromUrl(p.url))
    .filter((id): id is string => id !== null);
  return { text, attachmentIds };
}
