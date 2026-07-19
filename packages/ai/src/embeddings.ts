import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embedMany, type EmbeddingModel } from "ai";

/**
 * Embedder for the Phase B RAG chunks (rag_chunks.embedding vector(768)).
 *
 * `GoogleEmbedder` calls Gemini via the AI SDK; `StubEmbedder` is a
 * dependency-free, deterministic fake for tests and offline/dev runs where
 * no API key is configured. `createEmbedder` picks between them from env so
 * the ingestion worker never has to branch on this itself.
 */
export interface Embedder {
  readonly model: string;
  readonly dimensions: 768;
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_GOOGLE_EMBEDDING_MODEL = "gemini-embedding-001";
const EMBED_BATCH_SIZE = 100;
const RETRY_BACKOFF_MS = 2000;

/**
 * Batch a list of texts into chunks of `batchSize` and embed each batch via
 * `embedBatch`, retrying a failed batch exactly once after `backoffMs`. Pure
 * apart from the injected `embedBatch`/`sleep`, so the batching + retry
 * behaviour is unit-testable without any network access.
 */
export async function embedInBatches(
  texts: string[],
  batchSize: number,
  embedBatch: (batch: string[]) => Promise<number[][]>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  backoffMs: number = RETRY_BACKOFF_MS,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    if (batch.length === 0) continue;
    try {
      out.push(...(await embedBatch(batch)));
    } catch {
      await sleep(backoffMs);
      out.push(...(await embedBatch(batch)));
    }
  }
  return out;
}

/** Real embedder backed by Gemini's text-embedding model via the Vercel AI SDK. */
export class GoogleEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions = 768 as const;
  private readonly embeddingModel: EmbeddingModel<string>;

  constructor(config: { apiKey: string; modelId?: string }) {
    this.model = config.modelId ?? DEFAULT_GOOGLE_EMBEDDING_MODEL;
    const provider = createGoogleGenerativeAI({ apiKey: config.apiKey });
    this.embeddingModel = provider.textEmbedding(this.model);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return embedInBatches(texts, EMBED_BATCH_SIZE, (batch) => this.embedBatch(batch));
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const { embeddings } = await embedMany({
      model: this.embeddingModel,
      values: batch,
      providerOptions: { google: { outputDimensionality: this.dimensions } },
    });
    return embeddings;
  }
}

/**
 * Deterministic, dependency-free embedder for tests and stub/offline runs:
 * FNV-1a hashes the text into a seed, a seeded LCG fills a 768-length vector
 * from that seed, and the vector is L2-normalized. The same text always
 * produces the same vector; different texts produce (almost surely)
 * different vectors — enough to exercise ingestion/RAG plumbing without a
 * real embedding model.
 */
export class StubEmbedder implements Embedder {
  readonly model = "stub-embedder-v1";
  readonly dimensions = 768 as const;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => deterministicEmbedding(text, this.dimensions));
  }
}

function fnv1aHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Numerical-Recipes LCG — deterministic, no external dependency. */
function nextLcgState(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

function deterministicEmbedding(text: string, dimensions: number): number[] {
  let state = fnv1aHash(text) || 1; // never seed with 0 (LCG would degenerate)
  const vec = new Array<number>(dimensions);
  for (let i = 0; i < dimensions; i++) {
    state = nextLcgState(state);
    vec[i] = (state / 0xffffffff) * 2 - 1; // map uint32 -> [-1, 1]
  }
  return l2Normalize(vec);
}

function l2Normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/**
 * GoogleEmbedder when a Google API key is configured (and the stub isn't
 * explicitly forced via PEBBLE_EMBEDDER=stub); StubEmbedder otherwise — e.g.
 * local dev, CI, and any environment without GOOGLE_GENERATIVE_AI_API_KEY.
 */
export function createEmbedder(env: Record<string, string | undefined>): Embedder {
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (apiKey && env.PEBBLE_EMBEDDER !== "stub") {
    return new GoogleEmbedder({ apiKey, modelId: env.PEBBLE_EMBEDDING_MODEL ?? DEFAULT_GOOGLE_EMBEDDING_MODEL });
  }
  return new StubEmbedder();
}
