import { describe, expect, it } from "vitest";
import { DEFAULT_CACHE_TTL, ephemeralCacheControl, resolveCacheTtl } from "../src/cache";

describe("resolveCacheTtl", () => {
  it("defaults to 5m when PEBBLE_CACHE_TTL is unset", () => {
    expect(resolveCacheTtl({})).toBe("5m");
    expect(resolveCacheTtl({})).toBe(DEFAULT_CACHE_TTL);
  });

  it("opts into 1h on the exact literal '1h'", () => {
    expect(resolveCacheTtl({ PEBBLE_CACHE_TTL: "1h" })).toBe("1h");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(resolveCacheTtl({ PEBBLE_CACHE_TTL: "1H" })).toBe("1h");
    expect(resolveCacheTtl({ PEBBLE_CACHE_TTL: "  1h  " })).toBe("1h");
  });

  it("falls back to 5m on any other value (typo-safe, never silently upgrades everyone)", () => {
    expect(resolveCacheTtl({ PEBBLE_CACHE_TTL: "5m" })).toBe("5m");
    expect(resolveCacheTtl({ PEBBLE_CACHE_TTL: "1hr" })).toBe("5m");
    expect(resolveCacheTtl({ PEBBLE_CACHE_TTL: "60m" })).toBe("5m");
    expect(resolveCacheTtl({ PEBBLE_CACHE_TTL: "" })).toBe("5m");
  });

  it("defaults to process.env when no env arg is passed", () => {
    const prev = process.env.PEBBLE_CACHE_TTL;
    try {
      delete process.env.PEBBLE_CACHE_TTL;
      expect(resolveCacheTtl()).toBe("5m");
      process.env.PEBBLE_CACHE_TTL = "1h";
      expect(resolveCacheTtl()).toBe("1h");
    } finally {
      if (prev === undefined) delete process.env.PEBBLE_CACHE_TTL;
      else process.env.PEBBLE_CACHE_TTL = prev;
    }
  });
});

describe("ephemeralCacheControl", () => {
  it("omits ttl for the 5m default (the exact shape Anthropic expects for the default tier)", () => {
    expect(ephemeralCacheControl("5m")).toEqual({ type: "ephemeral" });
  });

  it("sets ttl:'1h' for the opt-in long-lived tier", () => {
    expect(ephemeralCacheControl("1h")).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
