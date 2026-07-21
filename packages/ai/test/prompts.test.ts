import type { MasterSnapshot } from "@pebble/shared";
import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "../src/prompts";

/** A minimal, valid MasterSnapshot — the digest text content is irrelevant here, only the breakpoint matters. */
function snapshot(): MasterSnapshot {
  return {
    materials: [],
    specs: [],
    makes: [],
    prices: [],
    installRates: [],
    rules: [],
    marginMatrix: [],
  };
}

describe("assembleSystemPrompt cache breakpoint (WP10 ttl threading)", () => {
  it("defaults to a ttl-less ephemeral breakpoint on the digest block when env is empty", () => {
    const assembled = assembleSystemPrompt(snapshot(), { env: {} });
    const digestBlock = assembled.blocks[1]!;
    expect(digestBlock.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("defaults the same way when no opts are passed at all", () => {
    const assembled = assembleSystemPrompt(snapshot());
    const digestBlock = assembled.blocks[1]!;
    expect(digestBlock.providerOptions?.anthropic?.cacheControl.type).toBe("ephemeral");
    expect(digestBlock.providerOptions?.anthropic?.cacheControl.ttl).toBeUndefined();
  });

  it("PEBBLE_CACHE_TTL=1h puts ttl:'1h' on the digest breakpoint", () => {
    const assembled = assembleSystemPrompt(snapshot(), { env: { PEBBLE_CACHE_TTL: "1h" } });
    const digestBlock = assembled.blocks[1]!;
    expect(digestBlock.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("the persona block (index 0) never carries a cache breakpoint, regardless of ttl", () => {
    const assembled = assembleSystemPrompt(snapshot(), { env: { PEBBLE_CACHE_TTL: "1h" } });
    expect(assembled.blocks[0]!.providerOptions).toBeUndefined();
  });

  it("reusing a cached digest text does not drop or stale the ttl on the breakpoint", () => {
    const snap = snapshot();
    const first = assembleSystemPrompt(snap, { env: { PEBBLE_CACHE_TTL: "1h" } });
    const cachedDigest = { hash: first.digestHash, text: first.blocks[1]!.content };
    const second = assembleSystemPrompt(snap, { cachedDigest, env: { PEBBLE_CACHE_TTL: "1h" } });
    expect(second.blocks[1]!.content).toBe(first.blocks[1]!.content); // text reused
    expect(second.blocks[1]!.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
