import { describe, expect, it } from "vitest";
import { createIngestModelFromEnv } from "../src/index";

/**
 * The env → model selection seam. Kept to selection logic only — we never call
 * the model (that would need a real API key + network), just assert which
 * branch env lands in and that the chosen model id is threaded through.
 */
describe("createIngestModelFromEnv", () => {
  it("returns null when no Google API key is configured", () => {
    expect(createIngestModelFromEnv({})).toBeNull();
    expect(createIngestModelFromEnv({ PEBBLE_INGEST_MODEL: "gemini-x" })).toBeNull();
  });

  it("builds a model from the default gemini id when a key is present", () => {
    const model = createIngestModelFromEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "test-key" });
    expect(model).not.toBeNull();
    // A concrete provider model object, not a bare string id.
    expect(typeof model).toBe("object");
    expect((model as { modelId: string }).modelId).toBe("gemini-3.5-flash");
  });

  it("honours PEBBLE_INGEST_MODEL over the gemini default", () => {
    const model = createIngestModelFromEnv({
      GOOGLE_GENERATIVE_AI_API_KEY: "test-key",
      PEBBLE_INGEST_MODEL: "gemini-3.5-pro-preview",
      PEBBLE_GEMINI_MODEL: "gemini-should-be-ignored",
    });
    expect((model as { modelId: string }).modelId).toBe("gemini-3.5-pro-preview");
  });

  it("falls back to PEBBLE_GEMINI_MODEL when no ingest-specific override is set", () => {
    const model = createIngestModelFromEnv({
      GOOGLE_GENERATIVE_AI_API_KEY: "test-key",
      PEBBLE_GEMINI_MODEL: "gemini-2.5-flash",
    });
    expect((model as { modelId: string }).modelId).toBe("gemini-2.5-flash");
  });
});
