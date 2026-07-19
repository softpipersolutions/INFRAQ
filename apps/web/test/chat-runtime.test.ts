import {
  applyExtracted,
  confirmAllProposed,
  initSlotState,
  type Intent,
  type RouteDecision,
} from "@pebble/ai";
import { describe, expect, it } from "vitest";
import {
  budgetFromEnv,
  buildSlotResponseText,
  isSlotFillingInProgress,
  resolveSlotState,
  selectLane,
  startOfUtcDayISO,
} from "../src/server/chat-runtime";

/** A canned router decision for a given intent (the classifier output stand-in). */
function decisionFor(intent: Intent): RouteDecision {
  return { lane: "claude", intent, escalated: false, reasons: [], deterministic: false };
}

describe("selectLane", () => {
  it("routes COMPUTE to the deterministic engine message", () => {
    const sel = selectLane(decisionFor("COMPUTE"), { slotFillingInProgress: false });
    expect(sel.handler).toBe("compute");
  });

  it("routes EXTRACT and SLOT_FILL to the slot-filling lane", () => {
    expect(selectLane(decisionFor("EXTRACT"), { slotFillingInProgress: false }).handler).toBe("slot");
    expect(selectLane(decisionFor("SLOT_FILL"), { slotFillingInProgress: false }).handler).toBe("slot");
  });

  it("stays in the slot lane while a capture is in progress, regardless of intent", () => {
    expect(selectLane(decisionFor("INTERPRET"), { slotFillingInProgress: true }).handler).toBe("slot");
  });

  it("routes LOOKUP / RECALL / INTERPRET / EXPLAIN to the Claude lane (default model)", () => {
    for (const intent of ["LOOKUP", "RECALL", "INTERPRET", "DRAFT_ASSIST", "EXPLAIN"] as Intent[]) {
      const sel = selectLane(decisionFor(intent), { slotFillingInProgress: false });
      expect(sel.handler).toBe("claude");
      expect(sel.claudeModel).toBe("default");
      expect(sel.escalated).toBe(false);
    }
  });

  it("escalates to Opus on low router confidence", () => {
    const sel = selectLane(decisionFor("INTERPRET"), {
      slotFillingInProgress: false,
      escalation: { routerConfidence: 0.2 },
    });
    expect(sel.claudeModel).toBe("opus");
    expect(sel.escalated).toBe(true);
    expect(sel.reasons.length).toBeGreaterThan(0);
  });

  it("escalates to Opus when the user challenges a draft decision", () => {
    const sel = selectLane(decisionFor("DRAFT_ASSIST"), {
      slotFillingInProgress: false,
      escalation: { userChallengedDecision: true },
    });
    expect(sel.claudeModel).toBe("opus");
  });
});

describe("budgetFromEnv", () => {
  it("defaults to 5 when unset or invalid", () => {
    expect(budgetFromEnv({})).toBe(5);
    expect(budgetFromEnv({ PEBBLE_DAILY_LLM_BUDGET_USD: "not-a-number" })).toBe(5);
    expect(budgetFromEnv({ PEBBLE_DAILY_LLM_BUDGET_USD: "-3" })).toBe(5);
  });
  it("honours a valid override", () => {
    expect(budgetFromEnv({ PEBBLE_DAILY_LLM_BUDGET_USD: "12.5" })).toBe(12.5);
    expect(budgetFromEnv({ PEBBLE_DAILY_LLM_BUDGET_USD: "0" })).toBe(0);
  });
});

describe("startOfUtcDayISO", () => {
  it("truncates to UTC midnight", () => {
    expect(startOfUtcDayISO(new Date("2026-07-19T15:42:11.000Z"))).toBe("2026-07-19T00:00:00.000Z");
  });
});

describe("resolveSlotState", () => {
  it("seeds a fresh state from null", () => {
    const state = resolveSlotState(null);
    expect(state.clientName.status).toBe("missing");
    expect(state.systemsRequired.value).toBeNull();
  });

  it("hydrates a stored partial state over a fresh baseline", () => {
    const stored = applyExtracted(initSlotState(), { clientName: "Acme" }) as unknown as Record<string, unknown>;
    const state = resolveSlotState(stored);
    expect(state.clientName.status).toBe("proposed");
    expect(state.clientName.value).toBe("Acme");
    expect(state.projectName.status).toBe("missing");
  });
});

describe("isSlotFillingInProgress", () => {
  it("is false for a fresh state and a fully-confirmed state", () => {
    expect(isSlotFillingInProgress(initSlotState())).toBe(false);
    const full = confirmAllProposed(
      applyExtracted(initSlotState(), {
        clientName: "Acme",
        projectName: "HQ",
        buildingType: "Commercial",
        floorsAbove: 4,
        floorAreaSqm: 450,
        systemsRequired: ["FAS"],
        makePreference: "Standard",
        projectTier: 2,
      }),
    );
    expect(isSlotFillingInProgress(full)).toBe(false);
  });

  it("is true mid-capture (a field is proposed but not all confirmed)", () => {
    const partial = applyExtracted(initSlotState(), { clientName: "Acme" });
    expect(isSlotFillingInProgress(partial)).toBe(true);
  });
});

describe("buildSlotResponseText", () => {
  it("asks for the next missing required field with a recap", () => {
    const text = buildSlotResponseText(applyExtracted(initSlotState(), { clientName: "Acme" }));
    expect(text).toContain("project"); // next required field is projectName
    expect(text).toContain("Confirmed:");
    expect(text).toContain("Proposed:");
    expect(text).toContain("Still needed:");
  });

  it("prompts to Confirm once every required field is captured", () => {
    const full = applyExtracted(initSlotState(), {
      clientName: "Acme",
      projectName: "HQ",
      buildingType: "Commercial",
      floorsAbove: 4,
      floorAreaSqm: 450,
      systemsRequired: ["FAS"],
      makePreference: "Standard",
      projectTier: 2,
    });
    expect(buildSlotResponseText(full)).toContain("Confirm");
  });
});
