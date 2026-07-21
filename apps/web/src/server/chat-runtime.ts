import { initSlotState, SLOT_FIELDS, type SlotState } from "@pebble/ai";
import { sumLlmCostSince, type Db } from "@pebble/db";

/**
 * Pure(ish) helpers behind the /api/chat agent route — factored out of the
 * streaming handler so they are unit-testable without HTTP: slot-state
 * hydration, the daily-budget guard, and the UTC-day window start. Nothing here
 * imports "server-only".
 *
 * Phase C.5 removed the lane machinery (`selectLane`, the slot-recap text
 * builders and the COMPUTE-lane message): the chat is now a single Sonnet-5
 * agent that routes itself via tool choice, so there are no lanes to pick and no
 * templated slot replies to emit — Pebble authors every visible word.
 */

// ─── Fixed responses ─────────────────────────────────────────────────────────

/** Shown (503) when the agent has no ANTHROPIC_API_KEY configured. */
export const MODEL_UNCONFIGURED_MESSAGE =
  "The AI assistant is not configured on this deployment (no ANTHROPIC_API_KEY). The structured screens — enquiry form, estimate review, history search — work without it.";

// ─── Slot-state hydration ────────────────────────────────────────────────────

/**
 * Hydrate a stored slot_state (or a fresh session's JSON `null`) into a full
 * `SlotState`. A missing/partial/legacy shape merges over a fresh baseline so
 * every field is always present.
 */
export function resolveSlotState(raw: Record<string, unknown> | null | undefined): SlotState {
  const base = initSlotState();
  if (!raw || typeof raw !== "object") return base;
  for (const f of SLOT_FIELDS) {
    const slot = (raw as Record<string, unknown>)[f];
    if (slot && typeof slot === "object" && "status" in slot && "value" in slot) {
      base[f] = slot as SlotState[typeof f];
    }
  }
  return base;
}

// ─── Daily budget guard ──────────────────────────────────────────────────────

export const DEFAULT_DAILY_BUDGET_USD = 5;

/** Parse PEBBLE_DAILY_LLM_BUDGET_USD (default 5); a bad/negative value falls back to 5. */
export function budgetFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PEBBLE_DAILY_LLM_BUDGET_USD;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_BUDGET_USD;
}

/** Start of the current UTC day as an ISO instant (the daily-budget window start). */
export function startOfUtcDayISO(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Start of the NEXT UTC day (the current day's start + 24h) as an ISO instant —
 * i.e. the instant the daily-budget window rolls over. The 429 body carries this
 * as `resetsAtISO` so the client can render a live "resets in …" countdown.
 */
export function startOfNextUtcDayISO(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export interface BudgetCheck {
  blocked: boolean;
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
}

/**
 * The daily-budget guard as a pure-ish helper (testable without HTTP): sum the
 * user's LLM spend since UTC-midnight and compare to the configured budget.
 */
export async function checkDailyBudget(
  db: Db,
  args: { userId?: string; now?: Date; env?: Record<string, string | undefined> },
): Promise<BudgetCheck> {
  const budgetUsd = budgetFromEnv(args.env ?? process.env);
  const sinceISO = startOfUtcDayISO(args.now ?? new Date());
  const spentUsd = await sumLlmCostSince(db, { userId: args.userId, sinceISO });
  return {
    blocked: spentUsd >= budgetUsd,
    spentUsd,
    budgetUsd,
    remainingUsd: Math.max(0, budgetUsd - spentUsd),
  };
}
