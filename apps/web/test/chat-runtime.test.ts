import { applyExtracted, initSlotState } from "@pebble/ai";
import { describe, expect, it } from "vitest";
import {
  budgetFromEnv,
  resolveSlotState,
  startOfUtcDayISO,
} from "../src/server/chat-runtime";

/**
 * Pure helpers behind the /api/chat agent route. Phase C.5 removed the lane
 * machinery (selectLane, the slot-recap text builders, the COMPUTE message), so
 * these cover only what survives: budget parsing, the UTC-day window start, and
 * slot-state hydration. The agent turn itself is exercised in chat-agent.test.ts.
 */

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
