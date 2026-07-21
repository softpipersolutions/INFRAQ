import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  attachmentIdFromUrl,
  budgetBannerText,
  formatCountdown,
  parseChatError,
  retryPayloadFromMessages,
  shouldOfferRetry,
} from "./chat-panel-helpers";

/**
 * Pure-helper coverage for the chat panel's WP13 robustness UX — error typing,
 * the budget countdown, the retry payload and the retry/offline gates. apps/web
 * has no jsdom, so the branching lives here (out of the component) and is tested
 * without a DOM, per the work plan.
 */

describe("parseChatError", () => {
  it("returns null when there is no error", () => {
    expect(parseChatError(null)).toBeNull();
    expect(parseChatError(undefined)).toBeNull();
  });

  it("classifies the 429 daily-budget body and surfaces resetsAtISO", () => {
    const err = new Error(
      JSON.stringify({
        error: "daily_budget_exceeded",
        message: "Daily AI budget of $5.00 reached.",
        resetsAtISO: "2026-07-20T00:00:00.000Z",
      }),
    );
    expect(parseChatError(err)).toEqual({
      kind: "budget",
      message: "Daily AI budget of $5.00 reached.",
      resetsAtISO: "2026-07-20T00:00:00.000Z",
    });
  });

  it("maps the 503 model_unconfigured code to unified admin copy (ignoring the long server message)", () => {
    const err = new Error(
      JSON.stringify({ error: "model_unconfigured", message: "The AI assistant is not configured …" }),
    );
    expect(parseChatError(err)).toEqual({
      kind: "unconfigured",
      message: "AI is not configured — ask your admin.",
      resetsAtISO: null,
    });
  });

  it("treats a non-JSON mid-stream drop as a retryable interruption", () => {
    const err = new Error("The assistant hit an error mid-response. Please try again.");
    expect(parseChatError(err)).toEqual({
      kind: "interrupted",
      message: "The reply was interrupted.",
      resetsAtISO: null,
    });
  });

  it("treats a raw network failure (non-JSON) as an interruption too", () => {
    expect(parseChatError(new Error("Failed to fetch"))?.kind).toBe("interrupted");
  });

  it("surfaces a 401 sign-in JSON (error only, no message) as generic copy", () => {
    const err = new Error(JSON.stringify({ error: "Sign in required" }));
    expect(parseChatError(err)).toEqual({ kind: "generic", message: "Sign in required", resetsAtISO: null });
  });
});

describe("shouldOfferRetry", () => {
  const interrupted = { kind: "interrupted" as const, message: "x", resetsAtISO: null };
  it("offers retry for an interruption that streamed nothing", () => {
    expect(shouldOfferRetry(interrupted, false)).toBe(true);
  });
  it("does not offer retry once bytes have streamed (partial persisted)", () => {
    expect(shouldOfferRetry(interrupted, false)).toBe(true);
    expect(shouldOfferRetry(interrupted, true)).toBe(false);
  });
  it("never offers retry for budget or unconfigured", () => {
    expect(shouldOfferRetry({ kind: "budget", message: "x", resetsAtISO: null }, false)).toBe(false);
    expect(shouldOfferRetry({ kind: "unconfigured", message: "x", resetsAtISO: null }, false)).toBe(false);
  });
  it("returns false for no error", () => {
    expect(shouldOfferRetry(null, false)).toBe(false);
  });
});

describe("formatCountdown", () => {
  it("formats hours + minutes", () => {
    expect(formatCountdown((3 * 3600 + 24 * 60) * 1000)).toBe("in 3h 24m");
  });
  it("formats minutes only under an hour", () => {
    expect(formatCountdown(12 * 60 * 1000)).toBe("in 12m");
  });
  it("formats seconds only under a minute", () => {
    expect(formatCountdown(45 * 1000)).toBe("in 45s");
  });
  it("clamps a negative/expired remainder to in 0s", () => {
    expect(formatCountdown(-5000)).toBe("in 0s");
  });
});

describe("budgetBannerText", () => {
  it("folds a live countdown into the banner copy", () => {
    const info = { kind: "budget" as const, message: "x", resetsAtISO: "2026-07-20T00:00:00.000Z" };
    const now = Date.parse("2026-07-19T20:36:00.000Z"); // 3h 24m before reset
    expect(budgetBannerText(info, now)).toBe("Daily AI budget reached — resets in 3h 24m");
  });
  it("falls back to a static sentence with no reset instant", () => {
    const info = { kind: "budget" as const, message: "x", resetsAtISO: null };
    expect(budgetBannerText(info, Date.now())).toBe("Daily AI budget reached — resets at UTC midnight.");
  });
});

describe("attachmentIdFromUrl", () => {
  it("extracts the id from a serve-route url", () => {
    expect(attachmentIdFromUrl("/api/chat/attachments/att-9")).toBe("att-9");
  });
  it("handles query strings / fragments", () => {
    expect(attachmentIdFromUrl("/api/chat/attachments/att-1?download=1")).toBe("att-1");
  });
  it("returns null for a non-matching url", () => {
    expect(attachmentIdFromUrl("https://example.com/x")).toBeNull();
    expect(attachmentIdFromUrl(undefined)).toBeNull();
    expect(attachmentIdFromUrl(null)).toBeNull();
  });
});

describe("retryPayloadFromMessages", () => {
  function userMsg(id: string, text: string, fileUrls: string[] = []): UIMessage {
    return {
      id,
      role: "user",
      parts: [
        ...fileUrls.map((url) => ({ type: "file" as const, url, mediaType: "application/pdf", filename: "f.pdf" })),
        { type: "text" as const, text },
      ],
    };
  }
  function assistantMsg(id: string, text: string): UIMessage {
    return { id, role: "assistant", parts: [{ type: "text", text }] };
  }

  it("derives the last user message's text + attachment ids", () => {
    const messages = [
      userMsg("u1", "first"),
      assistantMsg("a1", "reply"),
      userMsg("u2", "please read these", [
        "/api/chat/attachments/att-1",
        "/api/chat/attachments/att-2",
      ]),
    ];
    expect(retryPayloadFromMessages(messages)).toEqual({
      text: "please read these",
      attachmentIds: ["att-1", "att-2"],
    });
  });

  it("finds the last user message even when the tail is an (empty) assistant message", () => {
    const messages = [userMsg("u1", "resend me"), assistantMsg("a1", "")];
    expect(retryPayloadFromMessages(messages)).toEqual({ text: "resend me", attachmentIds: [] });
  });

  it("returns null when there is no user message or it has no text", () => {
    expect(retryPayloadFromMessages([assistantMsg("a1", "only assistant")])).toBeNull();
    expect(retryPayloadFromMessages([userMsg("u1", "   ")])).toBeNull();
    expect(retryPayloadFromMessages([])).toBeNull();
  });
});
