import type { ConversationScenario } from "../harness";
import { scenario as happyPath } from "./happy-path";
import { scenario as incrementalCorrection } from "./incremental-correction";
import { scenario as curveball } from "./curveball";
import { scenario as challengeEscalation } from "./challenge-escalation";
import { scenario as recallNoSideEffects } from "./recall-no-side-effects";
import { scenario as selfHeal } from "./self-heal";
import { scenario as budgetExhaustion } from "./budget-exhaustion";
import { scenario as explainWalkthrough } from "./explain-walkthrough";

/**
 * The 8 canonical live-model conversations (Phase C.5 WP5 / plan §Verification).
 * Order matches the plan's numbering; the runner (`scripts/chat-agent-eval.ts`)
 * iterates this list, optionally filtered by `--only <slug>`.
 */
export const SCENARIOS: ConversationScenario[] = [
  happyPath,
  incrementalCorrection,
  curveball,
  challengeEscalation,
  recallNoSideEffects,
  selfHeal,
  budgetExhaustion,
  explainWalkthrough,
];
