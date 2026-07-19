/**
 * Deterministic Opus-4.8 escalation (Phase C.5).
 *
 * ~95% of turns run on Sonnet 5. A turn escalates to Opus only on explicit,
 * cheap-to-check signals — the user challenging a linked draft, confirmed-slot
 * contradictions piling up, or an over-long review — and even then only while
 * the per-user daily Opus budget and turn cap allow it. Everything here is pure
 * and unit-tested; the route wires the persisted counters and env caps in.
 *
 * This module also owns the legacy `shouldEscalateToOpus` helper (a pure,
 * signal-based check) alongside the new budget-aware `decideEscalation`. The
 * route uses `decideEscalation`; `shouldEscalateToOpus` is retained as a small
 * pure utility with its own unit coverage.
 */

// ─── Legacy signal-based escalation (pure utility) ───────────────────────────

/** Signals that justify escalating the Claude lane to Opus 4.8. */
export interface EscalationSignals {
  /** Classifier confidence in [0,1]; low confidence → escalate. */
  routerConfidence?: number;
  /** Slots still contradictory after this many clarification rounds. */
  contradictionsAfterClarifications?: number;
  /** The user is challenging a draft decision. */
  userChallengedDecision?: boolean;
  /** Length of the current review conversation (assistant turns). */
  conversationTurns?: number;
}

export interface EscalationThresholds {
  minConfidence: number;
  maxContradictions: number;
  maxTurns: number;
}

export const DEFAULT_ESCALATION: EscalationThresholds = {
  minConfidence: 0.55,
  maxContradictions: 2,
  maxTurns: 12,
};

/**
 * Signal-based escalation check (pure). New route code uses `decideEscalation`,
 * which adds the daily Opus budget/turn caps; this remains a small standalone
 * utility for the signal thresholds.
 */
export function shouldEscalateToOpus(
  signals: EscalationSignals,
  thresholds: EscalationThresholds = DEFAULT_ESCALATION,
): { escalate: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (signals.routerConfidence !== undefined && signals.routerConfidence < thresholds.minConfidence) {
    reasons.push(`low router confidence (${signals.routerConfidence.toFixed(2)})`);
  }
  if ((signals.contradictionsAfterClarifications ?? 0) >= thresholds.maxContradictions) {
    reasons.push("slots remain contradictory after clarification");
  }
  if (signals.userChallengedDecision) {
    reasons.push("user challenged a draft decision");
  }
  if ((signals.conversationTurns ?? 0) > thresholds.maxTurns) {
    reasons.push("long review conversation");
  }
  return { escalate: reasons.length > 0, reasons };
}

// ─── Challenge detection ─────────────────────────────────────────────────────

/**
 * Heuristic: is the user challenging a drafted figure/decision? Only meaningful
 * once an estimate is linked to the session — the same words on an empty session
 * are just conversation, not a challenge to a draft.
 */
const CHALLENGE_RE =
  /(?:\bwrong\b|too\s+(?:many|few|high|low)|does(?:n['’]t|\s+not|nt)\s+add\s+up|why\s+is\s+this|should\s+be|\bdisagree\b|not\s+right|overpriced|too\s+costly)/i;

export function detectChallenge(message: string, hasLinkedEstimate: boolean): boolean {
  if (!hasLinkedEstimate) return false;
  return CHALLENGE_RE.test(message);
}

// ─── New budget-aware escalation ─────────────────────────────────────────────

export const DEFAULT_OPUS_DAILY_CAP_USD = 1;
export const DEFAULT_MAX_OPUS_TURNS = 5;

/** Resolve the per-user daily Opus spend cap from env (`PEBBLE_OPUS_DAILY_CAP_USD`, default $1). */
export function opusCapFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PEBBLE_OPUS_DAILY_CAP_USD;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_OPUS_DAILY_CAP_USD;
}

export interface EscalationDecision {
  model: "default" | "opus";
  /** Why the decision went the way it did — ledgered as `agent-opus:<reason>` / `agent[...]`. */
  reasons: string[];
}

/**
 * Decide whether this turn runs on Opus. Escalates on any of:
 *   - the user challenging a linked draft,
 *   - confirmed-slot contradictions ≥ 2,
 *   - a review conversation past 12 turns,
 * but SUPPRESSES the escalation (staying on the default model, with the reason
 * `escalation-suppressed:budget` appended) once the user's daily Opus spend cap
 * or turn cap is reached.
 */
export function decideEscalation(args: {
  message: string;
  hasLinkedEstimate: boolean;
  contradictions: number;
  conversationTurns: number;
  opusSpendTodayUsd: number;
  opusTurnsToday: number;
  capUsd?: number;
  maxOpusTurns?: number;
}): EscalationDecision {
  const capUsd = args.capUsd ?? opusCapFromEnv();
  const maxOpusTurns = args.maxOpusTurns ?? DEFAULT_MAX_OPUS_TURNS;

  const reasons: string[] = [];
  if (detectChallenge(args.message, args.hasLinkedEstimate)) reasons.push("challenge");
  if (args.contradictions >= 2) reasons.push("contradictions");
  if (args.conversationTurns > 12) reasons.push("turns");

  if (reasons.length === 0) return { model: "default", reasons: [] };

  const overBudget = args.opusSpendTodayUsd >= capUsd || args.opusTurnsToday >= maxOpusTurns;
  if (overBudget) {
    return { model: "default", reasons: [...reasons, "escalation-suppressed:budget"] };
  }

  return { model: "opus", reasons };
}
