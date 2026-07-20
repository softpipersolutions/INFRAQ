import { generateText, type LanguageModel } from "ai";

/**
 * Session auto-titling (Chat overhaul WP2). The FIRST exchange of a brand-new
 * chat (one user turn + Pebble's reply) is handed to Gemini Flash to mint a
 * short label for the session list — the same lightweight lane used for
 * summary compaction (`agent/compaction.ts`), never the drafting Claude model.
 * Fire-and-forget from `chat-agent.ts`'s `onFinish`: this module never throws
 * — any failure (bad output, no model, provider error) resolves to `null` so
 * the caller just leaves the session untitled (falls back to the message
 * preview — see `listChatSessions`'s `effectiveTitle`).
 */

/**
 * The title-generation prompt: a short noun-phrase label, no wrapping quotes
 * or trailing punctuation, matching the conversation's own language (so a
 * Hindi/Marathi enquiry gets a title in that language, not translated).
 */
export function buildTitlePrompt(userText: string, assistantText: string): string {
  return [
    "Write a short title for this chat conversation between a fire-safety estimator and Pebble.",
    "3 to 6 words, noun-phrase style (e.g. \"4-Storey Office FAS Enquiry\"), like a document title, not a sentence.",
    "No quotation marks, no trailing period or other punctuation flourishes, no emoji.",
    "Match the language the user is writing in.",
    "",
    `USER: ${userText}`,
    `ASSISTANT: ${assistantText}`,
    "",
    "Return ONLY the title text, nothing else.",
  ].join("\n");
}

export interface TitleUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GeneratedSessionTitle {
  /** Trimmed, single-line, unwrapped title — never empty. */
  title: string;
  usage: TitleUsage;
}

const MAX_TITLE_LENGTH = 80; // matches the router's user-rename cap (renameChatSession)

/**
 * Reduce the model's raw completion to a single clean line: first line only,
 * unwrap any quote marks the model added despite instructions, drop a trailing
 * sentence-ending punctuation mark, and clamp to `MAX_TITLE_LENGTH`. Returns
 * `null` if nothing usable survives (e.g. an empty completion).
 */
function sanitizeTitle(raw: string): string | null {
  let t = (raw.split("\n")[0] ?? "").trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  t = t.replace(/[.!?]+$/g, "").trim();
  if (t.length === 0) return null;
  return t.length > MAX_TITLE_LENGTH ? t.slice(0, MAX_TITLE_LENGTH).trim() : t;
}

/**
 * Generate a session title from the first exchange. Deterministic-ish
 * (temperature 0.2) and deliberately short (`maxOutputTokens` ~24) — this is a
 * label, not a summary. Never throws: any error (network, provider, empty/
 * unusable completion) resolves to `null` so the fire-and-forget caller can
 * simply skip persisting a title.
 */
export async function generateSessionTitle(args: {
  model: LanguageModel;
  userText: string;
  assistantText: string;
}): Promise<GeneratedSessionTitle | null> {
  try {
    const { text, usage } = await generateText({
      model: args.model,
      temperature: 0.2,
      maxOutputTokens: 24,
      prompt: buildTitlePrompt(args.userText, args.assistantText),
    });
    const title = sanitizeTitle(text);
    if (!title) return null;
    return {
      title,
      usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
    };
  } catch (err) {
    console.error("[title] generateSessionTitle failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
