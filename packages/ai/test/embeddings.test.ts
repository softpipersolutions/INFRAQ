import { describe, expect, it, vi } from "vitest";
import { GoogleEmbedder, StubEmbedder, createEmbedder, embedInBatches } from "../src/index";

function l2Norm(v: number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

describe("StubEmbedder", () => {
  it("returns one 768-dimensional vector per input text", async () => {
    const embedder = new StubEmbedder();
    const vectors = await embedder.embed(["fire alarm panel", "sprinkler head", "hydrant valve"]);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) expect(v).toHaveLength(768);
  });

  it("reports dimensions = 768", () => {
    expect(new StubEmbedder().dimensions).toBe(768);
  });

  it("is deterministic — the same text always embeds to the same vector", async () => {
    const embedder = new StubEmbedder();
    const [a] = await embedder.embed(["SITC M.S. Pipe Class 'C' 50 mm"]);
    const [b] = await embedder.embed(["SITC M.S. Pipe Class 'C' 50 mm"]);
    expect(a).toEqual(b);
  });

  it("embeds different texts to different vectors", async () => {
    const embedder = new StubEmbedder();
    const [a, b] = await embedder.embed(["fire alarm panel", "sprinkler head"]);
    expect(a).not.toEqual(b);
  });

  it("L2-normalizes every vector (norm ~= 1)", async () => {
    const embedder = new StubEmbedder();
    const vectors = await embedder.embed(["a", "some longer piece of text to embed", ""]);
    for (const v of vectors) {
      expect(l2Norm(v)).toBeCloseTo(1, 6);
    }
  });

  it("handles an empty input list", async () => {
    const embedder = new StubEmbedder();
    await expect(embedder.embed([])).resolves.toEqual([]);
  });
});

describe("createEmbedder", () => {
  it("returns a StubEmbedder when no Google API key is set", () => {
    const embedder = createEmbedder({});
    expect(embedder).toBeInstanceOf(StubEmbedder);
  });

  it("returns a GoogleEmbedder when a Google API key is set", () => {
    const embedder = createEmbedder({ GOOGLE_GENERATIVE_AI_API_KEY: "test-key" });
    expect(embedder).toBeInstanceOf(GoogleEmbedder);
    expect(embedder.model).toBe("gemini-embedding-001");
  });

  it("honours PEBBLE_EMBEDDING_MODEL when constructing a GoogleEmbedder", () => {
    const embedder = createEmbedder({
      GOOGLE_GENERATIVE_AI_API_KEY: "test-key",
      PEBBLE_EMBEDDING_MODEL: "gemini-embedding-2-preview",
    });
    expect(embedder.model).toBe("gemini-embedding-2-preview");
  });

  it("forces StubEmbedder when PEBBLE_EMBEDDER=stub even with an API key present", () => {
    const embedder = createEmbedder({ GOOGLE_GENERATIVE_AI_API_KEY: "test-key", PEBBLE_EMBEDDER: "stub" });
    expect(embedder).toBeInstanceOf(StubEmbedder);
  });

  it("every returned embedder reports 768 dimensions", () => {
    expect(createEmbedder({}).dimensions).toBe(768);
    expect(createEmbedder({ GOOGLE_GENERATIVE_AI_API_KEY: "k" }).dimensions).toBe(768);
  });
});

describe("embedInBatches", () => {
  it("splits texts into batches of the given size, in order", async () => {
    const texts = Array.from({ length: 5 }, (_, i) => `t${i}`);
    const seenBatches: string[][] = [];
    const embedBatch = vi.fn(async (batch: string[]) => {
      seenBatches.push(batch);
      return batch.map((t) => [t.length]);
    });
    const result = await embedInBatches(texts, 2, embedBatch, async () => {});
    expect(seenBatches).toEqual([["t0", "t1"], ["t2", "t3"], ["t4"]]);
    expect(result).toHaveLength(5);
  });

  it("retries a failed batch exactly once after the backoff, then succeeds", async () => {
    let attempt = 0;
    const embedBatch = vi.fn(async (batch: string[]) => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient failure");
      return batch.map(() => [1]);
    });
    const sleep = vi.fn(async () => {});
    const result = await embedInBatches(["only"], 100, embedBatch, sleep);
    expect(embedBatch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result).toEqual([[1]]);
  });

  it("propagates the error when the retry also fails", async () => {
    const embedBatch = vi.fn(async () => {
      throw new Error("still failing");
    });
    const sleep = vi.fn(async () => {});
    await expect(embedInBatches(["only"], 100, embedBatch, sleep)).rejects.toThrow("still failing");
    expect(embedBatch).toHaveBeenCalledTimes(2);
  });

  it("returns an empty array for an empty input list without calling embedBatch", async () => {
    const embedBatch = vi.fn(async (batch: string[]) => batch.map(() => [1]));
    const result = await embedInBatches([], 100, embedBatch, async () => {});
    expect(result).toEqual([]);
    expect(embedBatch).not.toHaveBeenCalled();
  });
});
