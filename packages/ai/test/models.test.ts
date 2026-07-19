import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  estimateCostUsd,
  modelConfigFromEnv,
  providerForModel,
  toLlmCallLog,
} from "../src/index";

describe("model configuration", () => {
  it("uses project defaults when env is empty", () => {
    expect(modelConfigFromEnv({})).toEqual(DEFAULT_MODELS);
  });
  it("honours env overrides", () => {
    const cfg = modelConfigFromEnv({
      PEBBLE_CLAUDE_DEFAULT_MODEL: "claude-sonnet-x",
      PEBBLE_CLAUDE_OPUS_MODEL: "claude-opus-y",
      PEBBLE_GEMINI_MODEL: "gemini-z",
    });
    expect(cfg).toEqual({ claudeDefault: "claude-sonnet-x", claudeOpus: "claude-opus-y", gemini: "gemini-z" });
  });
  it("infers the provider from the model id", () => {
    expect(providerForModel("gemini-3.5-flash")).toBe("google");
    expect(providerForModel("claude-opus-4-8")).toBe("anthropic");
  });
});

describe("cost accounting", () => {
  it("prices Opus higher than Sonnet higher than Gemini per token", () => {
    const opus = estimateCostUsd("claude-opus-4-8", 1_000_000, 1_000_000);
    const sonnet = estimateCostUsd("claude-sonnet-4-6", 1_000_000, 1_000_000);
    const gemini = estimateCostUsd("gemini-3.5-flash", 1_000_000, 1_000_000);
    expect(opus).toBeGreaterThan(sonnet);
    expect(sonnet).toBeGreaterThan(gemini);
  });
  it("builds an llm_calls ledger row with a computed cost", () => {
    const log = toLlmCallLog({ lane: "claude", model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 500, intent: "EXPLAIN" });
    expect(log.lane).toBe("claude");
    expect(log.intent).toBe("EXPLAIN");
    expect(log.costUsd).toBeGreaterThan(0);
  });
});


describe("estimateCostUsd with prompt-cache usage", () => {
  it("bills cache reads at 10% and writes at 125% of the input rate", () => {
    // sonnet: $3/M input. 1M cache-read = $0.30; 1M cache-write = $3.75.
    expect(estimateCostUsd("claude-sonnet-5", 0, 0, { cacheReadTokens: 1_000_000 })).toBeCloseTo(0.3, 6);
    expect(estimateCostUsd("claude-sonnet-5", 0, 0, { cacheWriteTokens: 1_000_000 })).toBeCloseTo(3.75, 6);
  });
  it("adds cache costs to fresh-token costs", () => {
    const fresh = estimateCostUsd("claude-sonnet-5", 1000, 100);
    const withCache = estimateCostUsd("claude-sonnet-5", 1000, 100, { cacheReadTokens: 10_000 });
    expect(withCache).toBeCloseTo(fresh + 0.3 * (10_000 / 1_000_000) * 10 / 10, 6);
    expect(withCache).toBeGreaterThan(fresh);
  });
  it("toLlmCallLog carries cache costs into costUsd", () => {
    const withoutCache = toLlmCallLog({ lane: "claude", model: "claude-sonnet-5", inputTokens: 100, outputTokens: 50 });
    const withCache = toLlmCallLog({ lane: "claude", model: "claude-sonnet-5", inputTokens: 100, outputTokens: 50, cache: { cacheReadTokens: 12_000, cacheWriteTokens: 12_000 } });
    expect(withCache.costUsd).toBeGreaterThan(withoutCache.costUsd);
  });
});
