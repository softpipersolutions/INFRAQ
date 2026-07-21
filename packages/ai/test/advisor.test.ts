import { describe, expect, it, vi } from "vitest";
import {
  ADVISOR_BETA_HEADER,
  ADVISOR_UNSUPPORTED_WARNING,
  advisorEnabled,
  parseAdvisorIterations,
  resolveAdvisorSupport,
  resolveTurnStrategy,
  withAdvisorBetaHeader,
} from "../src/index";

/**
 * WP12 advisor-tool pilot (PEBBLE_ADVISOR, default OFF). These tests pin the
 * seam's invariants regardless of provider support: the flag reader, the beta-
 * header merge, the installed-provider support probe (which doubles as an
 * executable record of the "unsupported by @ai-sdk/anthropic 2.0.8x" verdict),
 * the turn-strategy branches, and the defensive iteration parser used for
 * ledgering.
 */

describe("advisorEnabled — the pilot flag (default OFF)", () => {
  it("is on ONLY for the literal '1'", () => {
    expect(advisorEnabled({ PEBBLE_ADVISOR: "1" })).toBe(true);
    expect(advisorEnabled({ PEBBLE_ADVISOR: "0" })).toBe(false);
    expect(advisorEnabled({ PEBBLE_ADVISOR: "true" })).toBe(false);
    expect(advisorEnabled({})).toBe(false);
  });
});

describe("withAdvisorBetaHeader — the beta-header merge", () => {
  it("adds NOTHING when the flag is off (header absent, not empty)", () => {
    expect(withAdvisorBetaHeader(undefined, false)).toBeUndefined();
    expect(withAdvisorBetaHeader({ "x-foo": "bar" }, false)).toEqual({ "x-foo": "bar" });
  });

  it("adds the advisor beta header when the flag is on", () => {
    expect(withAdvisorBetaHeader(undefined, true)).toEqual({ "anthropic-beta": ADVISOR_BETA_HEADER });
    expect(ADVISOR_BETA_HEADER).toBe("advisor-tool-2026-03-01");
  });

  it("comma-joins with a pre-existing anthropic-beta value", () => {
    expect(withAdvisorBetaHeader({ "anthropic-beta": "other-beta-2025-01-01" }, true)).toEqual({
      "anthropic-beta": `other-beta-2025-01-01,${ADVISOR_BETA_HEADER}`,
    });
  });

  it("preserves unrelated headers while adding the beta", () => {
    expect(withAdvisorBetaHeader({ "x-foo": "bar" }, true)).toEqual({
      "x-foo": "bar",
      "anthropic-beta": ADVISOR_BETA_HEADER,
    });
  });
});

describe("resolveAdvisorSupport — installed @ai-sdk/anthropic (2.0.8x)", () => {
  it("reports NO advisor factory (the pilot is functionally the model switch today)", () => {
    const support = resolveAdvisorSupport();
    expect(support.supported).toBe(false);
    expect(support.factoryName).toBeUndefined();
  });

  it("flips to supported when a provider exposes an advisor factory (injected stub)", () => {
    const support = resolveAdvisorSupport({ advisor_20260301: () => ({}) });
    expect(support.supported).toBe(true);
    expect(support.factoryName).toBe("advisor_20260301");
  });

  it("exposes the exact warning the fallback logs when unsupported", () => {
    expect(ADVISOR_UNSUPPORTED_WARNING).toBe(
      "advisor unsupported by installed provider — using model switch",
    );
  });
});

describe("resolveTurnStrategy — flag off is byte-identical to the deterministic switch", () => {
  it("passes an Opus escalation straight through (no advisor, no warning)", () => {
    const warn = vi.fn();
    const strat = resolveTurnStrategy({ model: "opus" }, {}, { warn });
    expect(strat).toEqual({ model: "opus", extraTools: {}, intentPrefix: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes a default (non-escalating) turn straight through", () => {
    expect(resolveTurnStrategy({ model: "default" }, {})).toEqual({
      model: "default",
      extraTools: {},
      intentPrefix: null,
    });
  });
});

describe("resolveTurnStrategy — flag on", () => {
  it("does nothing on a non-escalating turn (advisor only matters on escalation)", () => {
    const warn = vi.fn();
    const strat = resolveTurnStrategy({ model: "default" }, { PEBBLE_ADVISOR: "1" }, { warn });
    expect(strat).toEqual({ model: "default", extraTools: {}, intentPrefix: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it("unsupported provider: warns once and falls back to the Opus model switch", () => {
    const warn = vi.fn();
    // No advisorTools override → probes the installed provider, which has none.
    const strat = resolveTurnStrategy({ model: "opus" }, { PEBBLE_ADVISOR: "1" }, { warn });
    expect(strat).toEqual({ model: "opus", extraTools: {}, intentPrefix: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(ADVISOR_UNSUPPORTED_WARNING);
  });

  it("supported provider (stub): keeps Sonnet, attaches the Opus advisor, labels agent-advisor", () => {
    const warn = vi.fn();
    const fakeTool = { type: "advisor_20260301", name: "advisor" };
    let capturedCfg: unknown = null;
    const advisorTools = {
      advisor_20260301: (cfg: unknown) => {
        capturedCfg = cfg;
        return fakeTool;
      },
    };
    const strat = resolveTurnStrategy({ model: "opus" }, { PEBBLE_ADVISOR: "1" }, { warn, advisorTools });

    expect(strat.model).toBe("default"); // executor stays Sonnet
    expect(strat.intentPrefix).toBe("agent-advisor");
    expect(strat.extraTools.advisor).toBe(fakeTool);
    expect(warn).not.toHaveBeenCalled();
    // The advisor is an Opus advisor, max_uses 2, ephemeral caching.
    expect(capturedCfg).toMatchObject({
      model: "claude-opus-4-8",
      maxUses: 2,
      cacheControl: { type: "ephemeral" },
    });
  });

  it("honours the Opus model-id env override for the advisor model", () => {
    let capturedCfg: unknown = null;
    const advisorTools = {
      advisor_20260301: (cfg: unknown) => {
        capturedCfg = cfg;
        return {};
      },
    };
    resolveTurnStrategy(
      { model: "opus" },
      { PEBBLE_ADVISOR: "1", PEBBLE_CLAUDE_OPUS_MODEL: "claude-opus-5" },
      { advisorTools },
    );
    expect(capturedCfg).toMatchObject({ model: "claude-opus-5" });
  });
});

describe("parseAdvisorIterations — defensive ledger parse", () => {
  it("returns [] for anything that is not a well-formed metadata blob", () => {
    expect(parseAdvisorIterations(undefined)).toEqual([]);
    expect(parseAdvisorIterations(null)).toEqual([]);
    expect(parseAdvisorIterations("nope")).toEqual([]);
    expect(parseAdvisorIterations({})).toEqual([]);
    expect(parseAdvisorIterations({ anthropic: {} })).toEqual([]);
    expect(parseAdvisorIterations({ anthropic: { iterations: null } })).toEqual([]);
    expect(parseAdvisorIterations({ anthropic: { iterations: "not-an-array" } })).toEqual([]);
  });

  it("keeps ONLY advisor_message iterations, dropping executor/compaction/fallback", () => {
    const parsed = parseAdvisorIterations({
      anthropic: {
        iterations: [
          { type: "compaction", inputTokens: 10, outputTokens: 1 },
          { type: "message", inputTokens: 100, outputTokens: 20 },
          { type: "advisor_message", model: "claude-opus-4-8", inputTokens: 500, outputTokens: 80 },
          { type: "fallback_message", model: "x", inputTokens: 5, outputTokens: 5 },
          { type: "advisor_message", model: "claude-opus-4-8", inputTokens: 300, outputTokens: 40 },
        ],
      },
    });
    expect(parsed).toEqual([
      { model: "claude-opus-4-8", inputTokens: 500, outputTokens: 80 },
      { model: "claude-opus-4-8", inputTokens: 300, outputTokens: 40 },
    ]);
  });

  it("coerces malformed token counts to 0 and a missing model to null", () => {
    const parsed = parseAdvisorIterations({
      anthropic: {
        iterations: [
          { type: "advisor_message" }, // no tokens, no model
          { type: "advisor_message", inputTokens: "500", outputTokens: NaN, model: 42 },
          "junk",
          null,
        ],
      },
    });
    expect(parsed).toEqual([
      { model: null, inputTokens: 0, outputTokens: 0 },
      { model: null, inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it("tolerates a nested usage.iterations passthrough", () => {
    const parsed = parseAdvisorIterations({
      anthropic: {
        usage: {
          iterations: [{ type: "advisor_message", model: "claude-opus-4-8", inputTokens: 7, outputTokens: 3 }],
        },
      },
    });
    expect(parsed).toEqual([{ model: "claude-opus-4-8", inputTokens: 7, outputTokens: 3 }]);
  });
});
