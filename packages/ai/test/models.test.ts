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
