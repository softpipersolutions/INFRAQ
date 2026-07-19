import { describe, expect, it } from "vitest";
import {
  DEFAULT_ESCALATION,
  decideEscalation,
  detectChallenge,
  opusCapFromEnv,
  shouldEscalateToOpus,
} from "../src/index";

describe("detectChallenge", () => {
  it("only fires when an estimate is linked", () => {
    expect(detectChallenge("this is wrong", false)).toBe(false);
    expect(detectChallenge("this is wrong", true)).toBe(true);
  });

  it("matches the challenge vocabulary (case-insensitive)", () => {
    for (const msg of [
      "That's WRONG",
      "too many detectors",
      "the price is too high",
      "too few sprinklers",
      "this doesn't add up",
      "why is this so much?",
      "it should be 12 not 20",
      "I disagree with the make",
      "that's not right",
      "this is overpriced",
      "the quote is too costly",
    ]) {
      expect(detectChallenge(msg, true), msg).toBe(true);
    }
  });

  it("does not fire on neutral messages", () => {
    expect(detectChallenge("looks good, please proceed", true)).toBe(false);
    expect(detectChallenge("add a hydrant system", true)).toBe(false);
  });
});

describe("decideEscalation — triggers", () => {
  const base = {
    message: "ok",
    hasLinkedEstimate: false,
    contradictions: 0,
    conversationTurns: 0,
    opusSpendTodayUsd: 0,
    opusTurnsToday: 0,
    capUsd: 1,
    maxOpusTurns: 5,
  };

  it("stays on default with no signals", () => {
    expect(decideEscalation(base)).toEqual({ model: "default", reasons: [] });
  });

  it("escalates on a challenge to a linked draft", () => {
    const d = decideEscalation({ ...base, message: "this is too high", hasLinkedEstimate: true });
    expect(d.model).toBe("opus");
    expect(d.reasons).toContain("challenge");
  });

  it("escalates on contradictions >= 2", () => {
    expect(decideEscalation({ ...base, contradictions: 2 }).model).toBe("opus");
    expect(decideEscalation({ ...base, contradictions: 1 }).model).toBe("default");
  });

  it("escalates on conversationTurns > 12", () => {
    expect(decideEscalation({ ...base, conversationTurns: 13 }).model).toBe("opus");
    expect(decideEscalation({ ...base, conversationTurns: 12 }).model).toBe("default");
  });

  it("collects multiple reasons", () => {
    const d = decideEscalation({
      ...base,
      message: "this is wrong",
      hasLinkedEstimate: true,
      contradictions: 3,
      conversationTurns: 20,
    });
    expect(d.model).toBe("opus");
    expect(d.reasons).toEqual(expect.arrayContaining(["challenge", "contradictions", "turns"]));
  });
});

describe("decideEscalation — budget suppression", () => {
  const trigger = {
    message: "this is too high",
    hasLinkedEstimate: true,
    contradictions: 0,
    conversationTurns: 0,
    opusSpendTodayUsd: 0,
    opusTurnsToday: 0,
    capUsd: 1,
    maxOpusTurns: 5,
  };

  it("suppresses when the daily spend cap is reached", () => {
    const d = decideEscalation({ ...trigger, opusSpendTodayUsd: 1 });
    expect(d.model).toBe("default");
    expect(d.reasons).toContain("escalation-suppressed:budget");
    expect(d.reasons).toContain("challenge"); // the would-be trigger is still recorded
  });

  it("suppresses when the daily turn cap is reached", () => {
    const d = decideEscalation({ ...trigger, opusTurnsToday: 5 });
    expect(d.model).toBe("default");
    expect(d.reasons).toContain("escalation-suppressed:budget");
  });

  it("does not suppress just below the caps", () => {
    const d = decideEscalation({ ...trigger, opusSpendTodayUsd: 0.99, opusTurnsToday: 4 });
    expect(d.model).toBe("opus");
    expect(d.reasons).not.toContain("escalation-suppressed:budget");
  });

  it("never suppresses a non-escalating turn (nothing to suppress)", () => {
    const d = decideEscalation({ ...trigger, message: "looks good", opusSpendTodayUsd: 99, opusTurnsToday: 99 });
    expect(d).toEqual({ model: "default", reasons: [] });
  });
});

describe("opusCapFromEnv", () => {
  it("defaults to $1 and reads the override", () => {
    expect(opusCapFromEnv({})).toBe(1);
    expect(opusCapFromEnv({ PEBBLE_OPUS_DAILY_CAP_USD: "2.5" })).toBe(2.5);
    expect(opusCapFromEnv({ PEBBLE_OPUS_DAILY_CAP_USD: "nonsense" })).toBe(1);
  });
});

describe("shouldEscalateToOpus (legacy compat)", () => {
  it("still returns the {escalate, reasons} shape used by the deprecated router", () => {
    expect(shouldEscalateToOpus({ routerConfidence: 0.9, conversationTurns: 3 }).escalate).toBe(false);
    expect(shouldEscalateToOpus({ contradictionsAfterClarifications: 2 }).escalate).toBe(true);
    expect(DEFAULT_ESCALATION.maxTurns).toBe(12);
  });
});
