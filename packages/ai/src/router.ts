import type { Lane, ModelConfig } from "./models";
import { shouldEscalateToOpus, type EscalationSignals } from "./agent/escalation";

/**
 * @deprecated Turn router (spec §4.4) — the pre-agent, lane-based routing.
 *
 * Phase C.5 makes the chat a single Sonnet-5 agent that routes itself via tool
 * choice (see `agent/`), so lanes and this router are on the way out. It is kept
 * working — and marked deprecated — only until WP3 rewires the /api/chat route;
 * WP3 deletes it. The escalation types/helpers it once owned now live in
 * `agent/escalation.ts` and are re-exported below for compat.
 *
 * The cheapest correct decision wins, in order:
 *   1. slot-filling in progress   → stay in the Claude lane (SLOT_FILL)
 *   2. an explicit UI button action → direct route, no model at all
 *   3. otherwise                    → one cheap Gemini enum classification
 */

// Re-export the escalation surface that used to live here (moved to agent/escalation.ts).
export * from "./agent/escalation";

export const INTENTS = [
  "LOOKUP",
  "EXTRACT",
  "RECALL",
  "INTERPRET",
  "DRAFT_ASSIST",
  "EXPLAIN",
  "COMPUTE",
  "SLOT_FILL",
] as const;
export type Intent = (typeof INTENTS)[number];

const GEMINI_INTENTS = new Set<Intent>(["LOOKUP", "EXTRACT", "RECALL"]);
const CLAUDE_INTENTS = new Set<Intent>(["INTERPRET", "DRAFT_ASSIST", "EXPLAIN", "SLOT_FILL"]);

export function laneForIntent(intent: Intent): Lane {
  if (intent === "COMPUTE") return "engine";
  if (GEMINI_INTENTS.has(intent)) return "gemini";
  if (CLAUDE_INTENTS.has(intent)) return "claude";
  return "claude";
}

/** UI actions that map straight to a lane without any classification. */
export type UiAction =
  | "generate" // COMPUTE → engines
  | "explain_line" // EXPLAIN → claude
  | "recompute" // COMPUTE → engines
  | "lookup_material" // LOOKUP → gemini
  | "search_history"; // RECALL → gemini

const UI_ACTION_INTENT: Record<UiAction, Intent> = {
  generate: "COMPUTE",
  recompute: "COMPUTE",
  explain_line: "EXPLAIN",
  lookup_material: "LOOKUP",
  search_history: "RECALL",
};

export interface RouteInput {
  /** Free-text user message (absent for pure UI actions). */
  message?: string;
  /** An explicit UI button action — takes precedence over classification. */
  uiAction?: UiAction;
  /** True when an enquiry slot-filling conversation is mid-flight. */
  slotFillingInProgress?: boolean;
  /** Escalation signals (only consulted for the Claude lane). */
  escalation?: EscalationSignals;
}

export interface RouteDecision {
  lane: Lane;
  intent: Intent;
  /** The concrete model id to call (undefined for the engine lane). */
  model?: string;
  escalated: boolean;
  reasons: string[];
  /** True when no classification model was needed to reach this decision. */
  deterministic: boolean;
}

/** A classifier turns a message into an intent + confidence (Gemini enum call). */
export type IntentClassifier = (
  message: string,
) => Promise<{ intent: Intent; confidence: number }>;

/**
 * Route a single turn. `classify` is injected (a cheap Gemini enum call in
 * production, a stub in tests) and is only invoked on the non-deterministic
 * path — slot-filling and UI actions resolve with zero model calls.
 */
export async function routeTurn(
  input: RouteInput,
  models: ModelConfig,
  classify: IntentClassifier,
): Promise<RouteDecision> {
  // 1. Slot-filling stays in the Claude lane.
  if (input.slotFillingInProgress) {
    return finalizeClaude("SLOT_FILL", models, input.escalation, true, []);
  }

  // 2. Explicit UI actions route directly, no model.
  if (input.uiAction) {
    const intent = UI_ACTION_INTENT[input.uiAction];
    return decorate(intent, models, input.escalation, true, []);
  }

  // 3. Classify (the only path that spends a model on routing).
  if (!input.message || input.message.trim() === "") {
    // Nothing to route — default to the Claude lane conservatively.
    return finalizeClaude("INTERPRET", models, input.escalation, true, ["empty input"]);
  }
  const { intent, confidence } = await classify(input.message);
  return decorate(intent, models, { ...input.escalation, routerConfidence: confidence }, false, []);
}

function decorate(
  intent: Intent,
  models: ModelConfig,
  escalation: EscalationSignals | undefined,
  deterministic: boolean,
  baseReasons: string[],
): RouteDecision {
  const lane = laneForIntent(intent);
  if (lane === "engine") {
    return { lane, intent, escalated: false, reasons: baseReasons, deterministic };
  }
  if (lane === "gemini") {
    return { lane, intent, model: models.gemini, escalated: false, reasons: baseReasons, deterministic };
  }
  return finalizeClaude(intent, models, escalation, deterministic, baseReasons);
}

function finalizeClaude(
  intent: Intent,
  models: ModelConfig,
  escalation: EscalationSignals | undefined,
  deterministic: boolean,
  baseReasons: string[],
): RouteDecision {
  const esc = shouldEscalateToOpus(escalation ?? {});
  return {
    lane: "claude",
    intent,
    model: esc.escalate ? models.claudeOpus : models.claudeDefault,
    escalated: esc.escalate,
    reasons: [...baseReasons, ...esc.reasons],
    deterministic,
  };
}
