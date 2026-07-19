import { generateText, type LanguageModel } from "ai";

/**
 * History compaction (Phase C.5).
 *
 * The agent replays only the last N verbatim turns; older history is folded into
 * a short running summary maintained by Gemini Flash. Tool payloads are never
 * replayed — outcomes live in the summary and the session-state block, and facts
 * are re-fetched fresh each turn (this is the biggest token saving and it kills
 * stale-fact hallucination). These helpers are the pure prompt builder + the
 * threshold check + a thin Flash call; the route owns the watermark bookkeeping.
 */

/** Verbatim-turn window (`PEBBLE_CHAT_WINDOW`, default 12). */
export const DEFAULT_CHAT_WINDOW = 12;

export function chatWindowFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PEBBLE_CHAT_WINDOW;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CHAT_WINDOW;
}

export interface SummaryMessage {
  role: string;
  content: string;
}

/**
 * The summary-refresh prompt. Instructs a ≤300-token rewrite that folds the new
 * messages into the previous summary under fixed headings, preserving exact
 * codes/filenames/figures and inventing nothing. Both the previous summary and
 * the new messages are embedded so the model has everything it needs in one call.
 */
export function buildSummaryPrompt(oldSummary: string | null, messages: SummaryMessage[]): string {
  const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n");
  const prev = oldSummary && oldSummary.trim().length > 0 ? oldSummary.trim() : "(none yet)";
  return [
    "You maintain a running summary of a fire-safety estimating conversation between an estimator and Pebble.",
    "Fold the new messages into the previous summary and return an updated summary UNDER 300 tokens.",
    "Keep only what future turns need, under these headings (omit a heading if it has nothing):",
    "- FACTS CAPTURED: enquiry/estimate details established (client, project, building type, floors, area, systems, tier, and any figures already quoted).",
    "- DECISIONS: what was agreed or created (enquiries, estimates, chosen makes).",
    "- CORRECTIONS: values the user changed, with the final value.",
    "- OPEN QUESTIONS: what is still missing or awaiting confirmation.",
    "- USER PREFERENCES: standing preferences the user expressed.",
    "Preserve exact material/rule codes, standard references, filenames and numbers already present. Never invent a figure. Drop small talk.",
    "",
    `PREVIOUS SUMMARY:\n${prev}`,
    "",
    `NEW MESSAGES SINCE THE LAST SUMMARY:\n${transcript.length > 0 ? transcript : "(none)"}`,
    "",
    "Return ONLY the updated summary text.",
  ].join("\n");
}

/** Refresh when the number of turns not yet folded into the summary exceeds the threshold (default 8). */
export function shouldRefreshSummary(args: { unsummarizedCount: number; threshold?: number }): boolean {
  return args.unsummarizedCount > (args.threshold ?? 8);
}

export interface SummaryUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Run the Flash summary refresh. Deterministic-ish (temperature 0.2) so summaries stay stable turn to turn. */
export async function refreshSummary(args: {
  model: LanguageModel;
  oldSummary: string | null;
  messages: SummaryMessage[];
}): Promise<{ summary: string; usage: SummaryUsage }> {
  const { text, usage } = await generateText({
    model: args.model,
    temperature: 0.2,
    prompt: buildSummaryPrompt(args.oldSummary, args.messages),
  });
  return {
    summary: text.trim(),
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
  };
}
