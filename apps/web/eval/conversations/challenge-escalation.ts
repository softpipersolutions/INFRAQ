import { listChatMessages, listVersions } from "@pebble/db";
import { citesRuleOrStandard, type CaseResult, type ConversationScenario, type EvalCtx } from "../harness";
import { createDraftViaHappyPath } from "./happy-path";

/**
 * Case 4 — challenge the draft, twice. Reuses the happy-path fixture to get a
 * real linked enquiry + LOCKED v1 estimate, then challenges it twice
 * ("that detector count looks wrong"). `decideEscalation`
 * (`packages/ai/src/agent/escalation.ts`) escalates a challenge on a linked
 * estimate straight to Opus; the reply must cite a rule/standard instead of
 * just asserting, and — since the model has no tool that mutates an estimate
 * (`propose_line_edit` only ever proposes) — the version count must be
 * unchanged.
 */

const CHALLENGE_1 = "Hold on, that detector count looks wrong to me — seems like too many for this floor area.";
const CHALLENGE_2 = "I still think this doesn't add up. Please explain exactly why that number is correct.";

async function run(ctx: EvalCtx): Promise<CaseResult> {
  const notes: string[] = [];
  const draft = await createDraftViaHappyPath(ctx);
  notes.push(`draft: enquiry ${draft.enquiryId}, estimate ${draft.estimateId}`);

  const versionsBefore = await listVersions(ctx.db, draft.estimateId);

  const c1 = await ctx.sendTurn(draft.sessionId, CHALLENGE_1);
  const c2 = await ctx.sendTurn(draft.sessionId, CHALLENGE_2);

  const messages = await listChatMessages(ctx.db, draft.sessionId, 100);
  const assistantMessages = messages.filter((m) => m.role === "assistant");
  // Every claude-opus llm_calls row this app ever inserts is ledgered with
  // intent `agent-opus:<reason>` by construction (`buildIntentLabel` in
  // chat-agent.ts) — so an assistant message persisted with a claude-opus*
  // model is exactly the evidence an `agent-opus:%` llm_calls row exists for
  // this session, without needing a raw SQL query out of package scope here.
  const opusUsed = assistantMessages.some((m) => (m.model ?? "").startsWith("claude-opus"));
  notes.push(opusUsed ? "an assistant turn ran on claude-opus (agent-opus: ledgered)" : "NO assistant turn ran on claude-opus");

  const citesRule = citesRuleOrStandard(c1.text) || citesRuleOrStandard(c2.text);
  notes.push(citesRule ? "reply cites a rule code / IS reference" : "reply does NOT cite a rule code / IS reference");

  const versionsAfter = await listVersions(ctx.db, draft.estimateId);
  const noMutation = versionsAfter.length === versionsBefore.length;
  notes.push(
    noMutation
      ? `zero estimate mutations (still ${versionsAfter.length} version(s))`
      : `estimate MUTATED: ${versionsBefore.length} -> ${versionsAfter.length} versions`,
  );

  const noProposedApplied = ![...c1.parts, ...c2.parts].some(
    (p) => p.type === "tool-propose_line_edit" && (p.output as { applied?: boolean } | undefined)?.applied === true,
  );
  notes.push(noProposedApplied ? "no propose_line_edit output claims 'applied'" : "a propose_line_edit output claims applied=true");

  const pass = opusUsed && citesRule && noMutation && noProposedApplied;
  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "challenge-escalation",
  description:
    "Challenging a linked draft twice escalates to Opus 4.8 (ledgered agent-opus:*), the reply cites a rule/standard, and zero estimate mutations occur.",
  run,
};
