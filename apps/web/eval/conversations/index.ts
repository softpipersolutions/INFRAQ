import type { ConversationScenario } from "../harness";
import { scenario as happyPath } from "./happy-path";
import { scenario as incrementalCorrection } from "./incremental-correction";
import { scenario as curveball } from "./curveball";
import { scenario as challengeEscalation } from "./challenge-escalation";
import { scenario as recallNoSideEffects } from "./recall-no-side-effects";
import { scenario as selfHeal } from "./self-heal";
import { scenario as budgetExhaustion } from "./budget-exhaustion";
import { scenario as explainWalkthrough } from "./explain-walkthrough";
import { scenario as clarificationFlow } from "./clarification-flow";
import { scenario as fileAnalysisTurn } from "./file-analysis-turn";
import { scenario as fileGenerationTurn } from "./file-generation-turn";
import { scenario as memoryRecallAcrossSessions } from "./memory-recall-across-sessions";
import { scenario as multiSessionIsolation } from "./multi-session-isolation";

/**
 * The 13 canonical live-model conversations (Phase C.5 WP5's original 8, plus
 * WP14's 5 closing-out-the-chat-overhaul scenarios). Order matches the
 * plan's/WP numbering; the runner (`scripts/chat-agent-eval.ts`) iterates this
 * list, optionally filtered by `--only <slug>`.
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
  clarificationFlow,
  fileAnalysisTurn,
  fileGenerationTurn,
  memoryRecallAcrossSessions,
  multiSessionIsolation,
];
