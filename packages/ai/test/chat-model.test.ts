import { describe, expect, it } from "vitest";
import { createChatModelsFromEnv } from "../src/index";

/**
 * The env → chat-lane-models selection seam. Selection logic only — we never
 * call a model (that needs a real key + network), just assert which branch env
 * lands in and that the resolved model ids are threaded through.
 */
describe("createChatModelsFromEnv", () => {
  it("returns all-null when nothing is configured (dev, zero creds)", () => {
    const models = createChatModelsFromEnv({});
    expect(models.classifier).toBeNull();
    expect(models.claudeDefault).toBeNull();
    expect(models.claudeOpus).toBeNull();
  });

  it("builds the Claude models from ANTHROPIC_API_KEY with default ids", () => {
    const models = createChatModelsFromEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(models.claudeDefault).not.toBeNull();
    expect(models.claudeOpus).not.toBeNull();
    expect((models.claudeDefault as { modelId: string }).modelId).toBe("claude-sonnet-4-6");
    expect((models.claudeOpus as { modelId: string }).modelId).toBe("claude-opus-4-8");
    // No Google lane configured → classifier stays null.
    expect(models.classifier).toBeNull();
  });

  it("honours the Claude model-id env overrides", () => {
    const models = createChatModelsFromEnv({
      ANTHROPIC_API_KEY: "sk-ant-test",
      PEBBLE_CLAUDE_DEFAULT_MODEL: "claude-sonnet-5",
      PEBBLE_CLAUDE_OPUS_MODEL: "claude-opus-5",
    });
    expect((models.claudeDefault as { modelId: string }).modelId).toBe("claude-sonnet-5");
    expect((models.claudeOpus as { modelId: string }).modelId).toBe("claude-opus-5");
  });

  it("builds the classifier from the Gemini Developer-API lane when a key is present", () => {
    const models = createChatModelsFromEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "g-test" });
    expect(models.classifier).not.toBeNull();
    expect((models.classifier as { modelId: string }).modelId).toBe("gemini-3.5-flash");
    // No Anthropic key → Claude lane null.
    expect(models.claudeDefault).toBeNull();
  });

  it("honours the Gemini model-id override for the classifier", () => {
    const models = createChatModelsFromEnv({
      GOOGLE_GENERATIVE_AI_API_KEY: "g-test",
      PEBBLE_GEMINI_MODEL: "gemini-2.5-flash",
    });
    expect((models.classifier as { modelId: string }).modelId).toBe("gemini-2.5-flash");
  });
});
