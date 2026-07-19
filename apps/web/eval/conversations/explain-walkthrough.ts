import {
  checkNoInventedNumbers,
  getDigestText,
  getPromptConstantsText,
  type CaseResult,
  type ConversationScenario,
  type EvalCtx,
} from "../harness";
import { createDraftViaHappyPath, RICH_MESSAGE } from "./happy-path";

/**
 * Case 8 — explain walkthrough. After a created draft, "why that many smoke
 * detectors?" should pull `explain_line` or `get_design_rules` and answer
 * with the rule code (`DL-FAS-001`, the seeded smoke-detector rule — see
 * `packages/db/src/seed/data.ts`) plus its standard reference (IS 2189) or the
 * CEIL(area/60) formula in prose ("per 60"). Numbers in the reply must still
 * trace to tool facts / the digest (same matcher as case 1).
 */

const QUESTION = "Why that many smoke detectors on this one? Walk me through it.";

async function run(ctx: EvalCtx): Promise<CaseResult> {
  const notes: string[] = [];
  const draft = await createDraftViaHappyPath(ctx);
  notes.push(`draft: enquiry ${draft.enquiryId}, estimate ${draft.estimateId}`);

  const turn = await ctx.sendTurn(draft.sessionId, QUESTION);

  const usedExplainTool = turn.parts.some(
    (p) => p.type === "tool-explain_line" || p.type === "tool-get_design_rules",
  );
  notes.push(usedExplainTool ? "explain_line or get_design_rules part present" : "neither explain_line nor get_design_rules was called");

  const citesRuleCode = /\bDL-FAS-001\b/.test(turn.text);
  const citesStandardOrFormula = /\bIS\s?2189\b/i.test(turn.text) || /per\s*60\b/i.test(turn.text);
  notes.push(citesRuleCode ? "reply cites DL-FAS-001" : "reply does NOT cite DL-FAS-001");
  notes.push(citesStandardOrFormula ? "reply cites IS 2189 or 'per 60'" : "reply cites NEITHER IS 2189 NOR 'per 60'");

  const digestText = await getDigestText(ctx.db);
  const haystacks = [
    JSON.stringify([...draft.turn1.parts, ...draft.turn2.parts, ...turn.parts]),
    RICH_MESSAGE,
    QUESTION,
    digestText,
    getPromptConstantsText(),
  ];
  const numberCheck = checkNoInventedNumbers(turn.text, haystacks);
  notes.push(
    numberCheck.ok
      ? `no invented numbers (checked ${numberCheck.checked.length} tokens)`
      : `INVENTED numbers: ${numberCheck.invented.join(",")}`,
  );

  const pass = usedExplainTool && citesRuleCode && citesStandardOrFormula && numberCheck.ok;
  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "explain-walkthrough",
  description:
    "After a created draft, 'why that many smoke detectors?' pulls explain_line/get_design_rules and cites DL-FAS-001 + IS 2189 (or the per-60 formula) with no invented figures.",
  run,
};
