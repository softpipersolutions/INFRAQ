import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODELS,
  laneForIntent,
  routeTurn,
  shouldEscalateToOpus,
  type Intent,
} from "../src/index";

const models = DEFAULT_MODELS;

describe("laneForIntent", () => {
  it("maps each intent to its lane", () => {
    expect(laneForIntent("LOOKUP")).toBe("gemini");
    expect(laneForIntent("EXTRACT")).toBe("gemini");
    expect(laneForIntent("RECALL")).toBe("gemini");
    expect(laneForIntent("INTERPRET")).toBe("claude");
    expect(laneForIntent("EXPLAIN")).toBe("claude");
    expect(laneForIntent("SLOT_FILL")).toBe("claude");
    expect(laneForIntent("COMPUTE")).toBe("engine");
  });
});

describe("routeTurn — deterministic-first", () => {
  it("slot-filling stays in the Claude lane without calling the classifier", async () => {
    const classify = vi.fn();
    const d = await routeTurn({ slotFillingInProgress: true, message: "3 floors" }, models, classify);
    expect(classify).not.toHaveBeenCalled();
    expect(d.lane).toBe("claude");
    expect(d.intent).toBe("SLOT_FILL");
    expect(d.deterministic).toBe(true);
    expect(d.model).toBe(models.claudeDefault);
  });

  it("a UI 'generate' action routes to the engine lane with no model", async () => {
    const classify = vi.fn();
    const d = await routeTurn({ uiAction: "generate" }, models, classify);
    expect(classify).not.toHaveBeenCalled();
    expect(d.lane).toBe("engine");
    expect(d.intent).toBe("COMPUTE");
    expect(d.model).toBeUndefined();
    expect(d.deterministic).toBe(true);
  });

  it("a UI 'lookup_material' action routes to the Gemini lane", async () => {
    const d = await routeTurn({ uiAction: "lookup_material" }, models, vi.fn());
    expect(d.lane).toBe("gemini");
    expect(d.intent).toBe("LOOKUP");
    expect(d.model).toBe(models.gemini);
  });

  it("otherwise classifies the message and maps to a lane", async () => {
    const classify = vi.fn(async () => ({ intent: "RECALL" as Intent, confidence: 0.9 }));
    const d = await routeTurn({ message: "what did we quote for the mall?" }, models, classify);
    expect(classify).toHaveBeenCalledOnce();
    expect(d.lane).toBe("gemini");
    expect(d.intent).toBe("RECALL");
    expect(d.deterministic).toBe(false);
  });

  it("escalates the Claude lane to Opus when classifier confidence is low", async () => {
    const classify = vi.fn(async () => ({ intent: "INTERPRET" as Intent, confidence: 0.2 }));
    const d = await routeTurn({ message: "hmm, not sure what I want" }, models, classify);
    expect(d.lane).toBe("claude");
    expect(d.model).toBe(models.claudeOpus);
    expect(d.escalated).toBe(true);
    expect(d.reasons.join(" ")).toMatch(/confidence/);
  });
});

describe("shouldEscalateToOpus", () => {
  it("does not escalate on clean signals", () => {
    expect(shouldEscalateToOpus({ routerConfidence: 0.9, conversationTurns: 3 }).escalate).toBe(false);
  });
  it("escalates on each individual trigger", () => {
    expect(shouldEscalateToOpus({ routerConfidence: 0.3 }).escalate).toBe(true);
    expect(shouldEscalateToOpus({ contradictionsAfterClarifications: 2 }).escalate).toBe(true);
    expect(shouldEscalateToOpus({ userChallengedDecision: true }).escalate).toBe(true);
    expect(shouldEscalateToOpus({ conversationTurns: 20 }).escalate).toBe(true);
  });
});
