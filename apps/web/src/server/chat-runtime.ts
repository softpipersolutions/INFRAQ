import {
  allRequiredConfirmed,
  FIELD_META,
  initSlotState,
  nextAction,
  shouldEscalateToOpus,
  SLOT_FIELDS,
  type EscalationSignals,
  type Intent,
  type RouteDecision,
  type SlotState,
  type SlotValue,
} from "@pebble/ai";
import { sumLlmCostSince, type Db } from "@pebble/db";

/**
 * Pure(ish) helpers behind the /api/chat route — factored out of the streaming
 * handler so they are unit-testable without HTTP: slot-state hydration, the
 * deterministic lane-selection decision, the daily-budget guard, and the
 * fixed-text bodies for the non-model lanes. Nothing here imports "server-only".
 */

// ─── Fixed responses ─────────────────────────────────────────────────────────

/** COMPUTE-class turns never call a model — pricing is deterministic. */
export const COMPUTE_LANE_MESSAGE =
  "Prices, quantities and totals are computed only by the deterministic pricing engine — I never calculate figures myself. Use the Generate or Recompute action on the estimate to (re)run the engine, then I can explain any resulting line.";

/** Shown (503) when the Claude lane has no ANTHROPIC_API_KEY configured. */
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

/** A capture is mid-flight once a field has a value but the record isn't fully confirmed. */
export function isSlotFillingInProgress(state: SlotState): boolean {
  const started = SLOT_FIELDS.some((f) => state[f].status !== "missing");
  return started && !allRequiredConfirmed(state);
}

function fmtValue(v: SlotValue): string {
  if (v === null) return "—";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/** Compact "confirmed / proposed / still-needed" recap for the slot-filling reply. */
export function buildSlotRecap(state: SlotState): string {
  const confirmed: string[] = [];
  const proposed: string[] = [];
  const missing: string[] = [];
  for (const meta of FIELD_META) {
    const slot = state[meta.field];
    if (slot.status === "confirmed") confirmed.push(`${meta.field}=${fmtValue(slot.value)}`);
    else if (slot.status === "proposed") proposed.push(`${meta.field}=${fmtValue(slot.value)}`);
    else if (meta.required) missing.push(meta.field);
  }
  return [
    `Confirmed: ${confirmed.length ? confirmed.join(", ") : "—"}`,
    `Proposed: ${proposed.length ? proposed.join(", ") : "—"}`,
    `Still needed: ${missing.length ? missing.join(", ") : "—"}`,
  ].join("\n");
}

/** The slot-filling lane's assistant text: next ask (or confirm prompt) + recap. */
export function buildSlotResponseText(state: SlotState): string {
  const na = nextAction(state);
  const recap = buildSlotRecap(state);
  if (na.kind === "ask") return `${na.question}\n\n${recap}`;
  if (na.kind === "confirm") {
    return `I have the required details. Please review and hit **Confirm** to create the enquiry and generate the draft.\n\n${recap}`;
  }
  return `All details are confirmed. Hit **Confirm** to create the enquiry and generate the draft.\n\n${recap}`;
}

// ─── Lane selection (deterministic-first, per §4.4) ──────────────────────────

export type LaneHandler = "slot" | "compute" | "claude";

export interface LaneSelection {
  handler: LaneHandler;
  intent: Intent;
  /** Which Claude model the claude handler should use. */
  claudeModel: "default" | "opus";
  escalated: boolean;
  reasons: string[];
}

/**
 * Map a router decision to a concrete handler:
 *   - slot-filling in progress, or an EXTRACT / SLOT_FILL intent → slot lane (Gemini)
 *   - COMPUTE → the deterministic engine message (no model)
 *   - everything else (LOOKUP / RECALL / INTERPRET / DRAFT_ASSIST / EXPLAIN)
 *     → the Claude lane, which reads/retrieves/explains via tools.
 *
 * Opus escalation is decided here from the same signals routeTurn saw, so it
 * applies uniformly even for intents routeTurn parked in the Gemini lane.
 */
export function selectLane(
  decision: RouteDecision,
  opts: { slotFillingInProgress: boolean; escalation?: EscalationSignals },
): LaneSelection {
  let handler: LaneHandler;
  if (opts.slotFillingInProgress || decision.intent === "EXTRACT" || decision.intent === "SLOT_FILL") {
    handler = "slot";
  } else if (decision.intent === "COMPUTE") {
    handler = "compute";
  } else {
    handler = "claude";
  }
  const esc = shouldEscalateToOpus(opts.escalation ?? {});
  return {
    handler,
    intent: decision.intent,
    claudeModel: esc.escalate ? "opus" : "default",
    escalated: esc.escalate,
    reasons: esc.reasons,
  };
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
