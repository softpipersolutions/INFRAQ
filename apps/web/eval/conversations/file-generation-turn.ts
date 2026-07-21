import { skillsLaneEnabled } from "@pebble/ai";
import { getOrCreateChatSession } from "@pebble/db";
import type { CaseResult, ConversationScenario, EvalCtx } from "../harness";

/**
 * Case 11 (WP14) — a file-generation turn. `generate_file` only exists as a
 * composed tool when `PEBBLE_SKILLS_LANE=1` (`attachmentsToolset`,
 * `skillsEnabled` gate) AND a live Anthropic key resolves a real `SkillsLane`
 * (`createSkillsLaneFromEnv`) — with the flag off (the default) the tool has
 * no schema and costs nothing, so there is nothing for this scenario to
 * exercise. Rather than fail (a false regression signal), it SKIPS cleanly
 * with a note when the flag is off, and only runs the real assertions when
 * it's genuinely on. `runAgentTurn` reads the flag from `process.env`
 * (`deps.env ?? process.env`, same as this scenario's own check), matching
 * how the harness's `sendTurn` calls it.
 */

const INSTRUCTION =
  "Please generate a small draft xlsx summarizing three fire-safety systems (FAS, Hydrant, Extinguisher) with a " +
  "one-line note on each. Keep it short — this is just a working draft for me, not an official document.";

async function run(ctx: EvalCtx): Promise<CaseResult> {
  if (!skillsLaneEnabled(process.env)) {
    return {
      pass: true,
      skipped: true,
      notes: [
        "SKIPPED: PEBBLE_SKILLS_LANE is not '1' in this environment — generate_file is only composed when the " +
          "skills-lane flag is on. This scenario is a clean no-op without it (not a failure).",
      ],
    };
  }

  const notes: string[] = [];
  const sessionId = ctx.makeSession();
  await getOrCreateChatSession(ctx.db, { sessionId, userId: ctx.user.firebaseUid });

  const turn = await ctx.sendTurn(sessionId, INSTRUCTION);

  const genParts = turn.parts.filter((p) => p.type === "tool-generate_file");
  notes.push(genParts.length > 0 ? `tool-generate_file called (${genParts.length} time(s))` : "generate_file was NOT called");

  const succeeded = genParts.some((p) => {
    if (p.state !== "output-available") return false;
    const output = p.output as { ok?: boolean } | undefined;
    return output?.ok === true;
  });
  notes.push(succeeded ? "generate_file succeeded (output.ok === true)" : "generate_file did NOT succeed");

  const outputMarksDraft = genParts.some((p) => {
    const output = p.output as { draft?: boolean } | undefined;
    return output?.draft === true;
  });
  const replyMentionsDraft = /\bdraft\b/i.test(turn.text);
  const mentionsDraft = outputMarksDraft || replyMentionsDraft;
  notes.push(
    mentionsDraft
      ? `output/reply marks the file as a DRAFT (output.draft=${outputMarksDraft}, reply mentions "draft"=${replyMentionsDraft})`
      : "NEITHER the tool output NOR the reply text mentions DRAFT",
  );

  const pass = succeeded && mentionsDraft;
  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "file-generation-turn",
  description:
    "PEBBLE_SKILLS_LANE-gated: asking for a small xlsx draft calls generate_file successfully and the hand-off explicitly marks it a DRAFT (never an official document). Skips cleanly (pass, not fail) when the flag is off.",
  run,
};
