import { tool, type Tool } from "ai";
import { z } from "zod";

/**
 * The module-agnostic STRUCTURED CLARIFICATION tool (Phase C.5 chat overhaul WP6).
 *
 * Like the master-data digest and the policy block, `ask_user` belongs to the
 * agent CORE, not to any one module: every composition gets it (see
 * `composeAgent`). It lets the agent turn a genuinely ambiguous required field
 * into a short, tappable option menu instead of an open-ended question — the
 * Cowork-style "option chips" the chat renders as buttons.
 *
 * It is a tool with NO `execute`. In the AI SDK a tool call with no executor
 * produces no tool result, so the multi-step loop cannot continue past it: the
 * turn ends AT the call and the model's question is the last thing on screen.
 * The user's answer arrives as their NEXT message (they tap a chip, which sends
 * that option's label, or just type). The chat route also lists `ask_user` in
 * its `stopWhen` as a belt-and-braces stop so the turn always ends here even if
 * a future SDK change would otherwise keep looping.
 */

export const ASK_USER_TOOL_NAME = "ask_user";

/** Zod schema for an `ask_user` call — a question plus 2–4 option chips. */
export const askUserInputSchema = z.object({
  question: z.string().min(1),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        detail: z.string().max(200).optional(),
      }),
    )
    .min(2)
    .max(4),
  allowFreeText: z.boolean(),
});

export type AskUserInput = z.infer<typeof askUserInputSchema>;

/**
 * Build the `ask_user` clarification tool. Deliberately has NO `execute` — the
 * call itself IS the output (a rendered option menu), and its absence is what
 * ends the generation at the question so the user can answer next.
 */
export function buildAskUserTool(): Tool {
  return tool({
    description:
      "Ask the user a short, structured clarification when a REQUIRED enquiry field is genuinely ambiguous and a menu of 2–4 concrete options disambiguates faster than an open question. The user sees the options as buttons; their choice arrives as their NEXT message (a tapped chip sends that option's label, or they type their own answer when allowFreeText is true). Give each option a short `detail` when it helps. NEVER use this to confirm enquiry creation — that flow requires restating the complete record and getting an explicit yes, never a menu. Never use it for a fact a tool can fetch. At most one ask_user call per turn.",
    inputSchema: askUserInputSchema,
    // No execute: a tool call with no result ends the turn at the question.
  });
}
