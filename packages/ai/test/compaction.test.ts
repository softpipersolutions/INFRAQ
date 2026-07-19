import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import {
  buildSummaryPrompt,
  chatWindowFromEnv,
  DEFAULT_CHAT_WINDOW,
  refreshSummary,
  shouldRefreshSummary,
} from "../src/index";

/**
 * A minimal LanguageModelV2-shaped stub for generateText's doGenerate path —
 * returns plain text + usage and captures the prompt it was called with. Same
 * technique as ingest-extract.test.ts (we structurally match and cast through
 * LanguageModel rather than importing the provider type).
 */
function stubTextModel(
  text: string,
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {
    inputTokens: 900,
    outputTokens: 120,
    totalTokens: 1020,
  },
) {
  const calls: Array<{ prompt: unknown }> = [];
  const model = {
    specificationVersion: "v2",
    provider: "test-provider",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: async (options: { prompt: unknown }) => {
      calls.push({ prompt: options.prompt });
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage,
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("doStream not implemented in stub");
    },
  } as unknown as LanguageModel;
  return { model, calls };
}

describe("shouldRefreshSummary", () => {
  it("refreshes only past the threshold (default 8 → refresh at 9)", () => {
    expect(shouldRefreshSummary({ unsummarizedCount: 8 })).toBe(false);
    expect(shouldRefreshSummary({ unsummarizedCount: 9 })).toBe(true);
    expect(shouldRefreshSummary({ unsummarizedCount: 0 })).toBe(false);
  });

  it("honours a custom threshold", () => {
    expect(shouldRefreshSummary({ unsummarizedCount: 3, threshold: 2 })).toBe(true);
    expect(shouldRefreshSummary({ unsummarizedCount: 2, threshold: 2 })).toBe(false);
  });
});

describe("buildSummaryPrompt", () => {
  it("embeds the previous summary and the new messages, with the ≤300-token instruction", () => {
    const prompt = buildSummaryPrompt("OLD SUMMARY: Acme mall, FAS + Sprinkler.", [
      { role: "user", content: "make it tier 3" },
      { role: "assistant", content: "Noted, tier 3." },
    ]);
    expect(prompt).toContain("OLD SUMMARY: Acme mall, FAS + Sprinkler.");
    expect(prompt).toContain("USER: make it tier 3");
    expect(prompt).toContain("ASSISTANT: Noted, tier 3.");
    expect(prompt).toMatch(/UNDER 300 tokens/i);
    expect(prompt).toMatch(/CORRECTIONS/);
    expect(prompt).toMatch(/OPEN QUESTIONS/);
  });

  it("handles a null previous summary", () => {
    const prompt = buildSummaryPrompt(null, [{ role: "user", content: "hi" }]);
    expect(prompt).toContain("(none yet)");
    expect(prompt).toContain("USER: hi");
  });
});

describe("refreshSummary", () => {
  it("returns the model's text (trimmed) and mapped usage", async () => {
    const { model, calls } = stubTextModel("  FACTS CAPTURED: Acme mall.  ", {
      inputTokens: 1500,
      outputTokens: 90,
      totalTokens: 1590,
    });
    const result = await refreshSummary({
      model,
      oldSummary: "prev summary text",
      messages: [{ role: "user", content: "8 floors" }],
    });
    expect(result.summary).toBe("FACTS CAPTURED: Acme mall.");
    expect(result.usage).toEqual({ inputTokens: 1500, outputTokens: 90 });
    expect(calls).toHaveLength(1);
  });

  it("defaults usage to 0 when the provider omits token counts", async () => {
    const { model } = stubTextModel("summary", { inputTokens: undefined, outputTokens: undefined });
    const result = await refreshSummary({ model, oldSummary: null, messages: [] });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("chatWindowFromEnv", () => {
  it("defaults to 12 and reads a valid override", () => {
    expect(DEFAULT_CHAT_WINDOW).toBe(12);
    expect(chatWindowFromEnv({})).toBe(12);
    expect(chatWindowFromEnv({ PEBBLE_CHAT_WINDOW: "20" })).toBe(20);
    expect(chatWindowFromEnv({ PEBBLE_CHAT_WINDOW: "0" })).toBe(12);
    expect(chatWindowFromEnv({ PEBBLE_CHAT_WINDOW: "notanumber" })).toBe(12);
  });
});
