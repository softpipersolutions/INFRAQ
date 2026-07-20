import { describe, expect, it } from "vitest";
import { historyRowsToUIMessages } from "./history-to-ui-messages";

/**
 * Pure-function coverage for the chat.history -> UIMessage hydration mapping
 * (Phase C.5 WP4). This is the "no DOM needed" verification route called out
 * in the work plan: apps/web has no jsdom/testing-library, so component
 * rendering isn't exercised here — only the plumbing that feeds it.
 */
describe("historyRowsToUIMessages", () => {
  it("maps a legacy text-only row (parts null) to a single synthetic text part", () => {
    const messages = historyRowsToUIMessages([
      { id: "01AAA", role: "user", content: "Hello Pebble", parts: null },
    ]);
    expect(messages).toEqual([
      {
        id: "01AAA",
        role: "user",
        parts: [{ type: "text", text: "Hello Pebble" }],
      },
    ]);
  });

  it("reuses persisted parts verbatim when present (tool activity + receipt survive a reload)", () => {
    const parts = [
      { type: "text", text: "Here's what I found." },
      {
        type: "tool-get_design_rules",
        toolCallId: "call_1",
        state: "output-available",
        input: { systemType: "FAS" },
        output: [{ ruleCode: "DL-FAS-001", standardReference: "IS 2189" }],
      },
      {
        type: "tool-create_enquiry",
        toolCallId: "call_2",
        state: "output-available",
        input: { userConfirmed: true },
        output: { ok: true, enquiryId: "ENQ-1", estimateId: "EST-1" },
      },
    ];
    const messages = historyRowsToUIMessages([
      { id: "01BBB", role: "assistant", content: "Here's what I found.", parts },
    ]);
    expect(messages).toEqual([{ id: "01BBB", role: "assistant", parts }]);
  });

  it("round-trips an ask_user clarification part (input-available, no output) verbatim", () => {
    const parts = [
      {
        type: "tool-ask_user",
        toolCallId: "call_ask",
        state: "input-available",
        input: {
          question: "Which building type is this?",
          options: [{ label: "Commercial", detail: "offices, retail" }, { label: "Residential" }],
          allowFreeText: true,
        },
      },
    ];
    const messages = historyRowsToUIMessages([
      {
        id: "01AXU",
        role: "assistant",
        content: "[Asked: Which building type is this? — options: Commercial | Residential]",
        parts,
      },
    ]);
    expect(messages).toEqual([{ id: "01AXU", role: "assistant", parts }]);
  });

  it("maps any non-'user' role to 'assistant' (defensive against unexpected DB values)", () => {
    const messages = historyRowsToUIMessages([
      { id: "01CCC", role: "system", content: "internal note", parts: null },
    ]);
    expect(messages[0]?.role).toBe("assistant");
  });

  it("preserves chronological row order and ids", () => {
    const messages = historyRowsToUIMessages([
      { id: "01AAA", role: "user", content: "first", parts: null },
      { id: "01BBB", role: "assistant", content: "second", parts: null },
      { id: "01CCC", role: "user", content: "third", parts: null },
    ]);
    expect(messages.map((m) => m.id)).toEqual(["01AAA", "01BBB", "01CCC"]);
  });

  it("treats an empty parts array as real content, not a fallback trigger", () => {
    // `parts ?? fallback` only substitutes on null/undefined, per the router's
    // contract (`unknown[] | null`) — an explicit empty array is left as-is.
    const messages = historyRowsToUIMessages([
      { id: "01DDD", role: "assistant", content: "", parts: [] },
    ]);
    expect(messages[0]?.parts).toEqual([]);
  });

  it("returns an empty list for an empty history", () => {
    expect(historyRowsToUIMessages([])).toEqual([]);
  });

  it("widens a persisted user file part into a FileUIPart with the serve-route url (WP8)", () => {
    const messages = historyRowsToUIMessages([
      {
        id: "01FILE",
        role: "user",
        content: "here are the details",
        parts: [{ type: "file", filename: "notes.txt", mediaType: "text/plain", attachmentId: "att-9", v: 1 }],
      },
    ]);
    expect(messages[0]?.parts).toEqual([
      { type: "file", mediaType: "text/plain", filename: "notes.txt", url: "/api/chat/attachments/att-9" },
    ]);
  });

  it("passes non-file parts through untouched even alongside a file part", () => {
    const messages = historyRowsToUIMessages([
      {
        id: "01MIX",
        role: "user",
        content: "text",
        parts: [
          { type: "file", filename: "a.pdf", mediaType: "application/pdf", attachmentId: "att-1", v: 1 },
          { type: "text", text: "text" },
        ],
      },
    ]);
    expect(messages[0]?.parts).toEqual([
      { type: "file", mediaType: "application/pdf", filename: "a.pdf", url: "/api/chat/attachments/att-1" },
      { type: "text", text: "text" },
    ]);
  });
});
