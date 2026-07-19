import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

/**
 * Second-pass verification for Phase B staged ingestion records — the guard rail
 * behind the FULL AUTO-APPROVE lane. Where `./extract.ts` READS a source document
 * into proposed rows, this AUDITS one already-proposed row back against its own
 * source line and returns a gate decision: approve / reject / unsure. It is a
 * genuine second check (a different prompt, run temperature-0), never a rubber
 * stamp, and it is explicitly a GATE — it may only judge, never rewrite the row.
 *
 * Like the extraction lane, the model is injected so orchestration (batching,
 * ledgering, committing) lives in `@pebble/worker` and this stays unit-testable
 * with a stubbed LanguageModel and no API key.
 */

/** Bump on EVERY change to `buildVerifyPrompt` so a decision can be traced to its prompt. */
export const STAGED_VERIFY_PROMPT_VERSION = "staged-verify-v2";

/**
 * The verdict a verification pass returns. `issues` is expected to be empty when
 * the verdict is `approve` and to carry the human-readable reason(s) otherwise;
 * the enum + [0,1] confidence are enforced here so a malformed model reply is
 * rejected loudly by generateObject rather than silently committing garbage.
 */
export const stagedVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject", "unsure"]),
  confidence: z.number().min(0).max(1),
  issues: z.array(z.string()),
});
export type StagedVerdict = z.infer<typeof stagedVerdictSchema>;

export interface BuildVerifyPromptArgs {
  /** The staged row's target master (materials / prices / makes / install_rates). */
  targetMaster: string;
  /** The proposed staged payload — rendered verbatim as pretty JSON for the auditor. */
  proposed: unknown;
  /** The exact source line the record was extracted from (every payload carries it). */
  sourceText: string;
  /** The source document's filename, for context. */
  filename: string;
  /** The source document's date (YYYY-MM-DD) when known, else null. */
  docDateISO: string | null;
}

/**
 * Build the (deterministic) verification prompt. The task is framed as an AUDIT:
 * the model must approve only when the record faithfully matches the source line,
 * reject a clear misrepresentation, and choose `unsure` when the given text does
 * not let it decide — and it is told, explicitly, that it is a gate and must
 * never invent a correction.
 */
export function buildVerifyPrompt(args: BuildVerifyPromptArgs): string {
  return [
    "You are auditing a machine-extracted record against its source DESCRIPTION from a historical fire-safety proposal.",
    "A previous pass read a BOQ table row and produced the PROPOSED record below. Your job is to decide whether that record should be committed to the clean master data. You are a GATE, not an editor.",
    "",
    "IMPORTANT — what you can and cannot see: the source text below is ONLY the row's",
    "DESCRIPTION cell. The row's quantity, unit and price were read from separate table",
    "COLUMNS that are NOT included here. Therefore:",
    "- NEVER reject or mark unsure merely because a price, quantity or unit value does not",
    "  appear in the source text — it came from a column you cannot see.",
    "- Judge the price ONLY for plausibility given what the item is (order of magnitude):",
    "  a smoke detector at ₹4,50,000 or a fire pump at ₹12 is wrong; a detector at ₹1,450",
    "  or an MS pipe metre at ₹675 is plausible.",
    "",
    "Approve ONLY if ALL of these hold:",
    "- the material / name in the record faithfully matches the source description (no invented items, no drifted meaning);",
    "- any brand claimed in the record actually appears in the source description;",
    "- the classification fields (system, category) are sensible for the description — e.g. a",
    "  '150 mm dia' pipe/valve item categorised as 'Pump' is WRONG even if it sits in a pump-room section;",
    "- the unit, where the description implies one (e.g. 'per metre', 'set of'), does not contradict it;",
    "- the price passes the plausibility test above.",
    "",
    "Reject when the record clearly misrepresents the description (wrong item, invented brand, absurd price, wrong category).",
    "Choose unsure only for genuine ambiguity — a description too thin to identify the item at all, or a price you cannot judge either way. Unsure is not a failure; it routes the row to a human.",
    "",
    "Return: verdict (approve | reject | unsure), confidence in [0,1], and issues (a list of short reasons; leave it empty when you approve).",
    "You are a gate, not an editor: approve, reject, or mark unsure — never invent corrections, never rewrite fields, never propose a better value.",
    "",
    `Target master: ${args.targetMaster}`,
    `Source filename: ${args.filename}`,
    `Source document date: ${args.docDateISO ?? "unknown"}`,
    "",
    "Source line (verbatim from the document):",
    args.sourceText,
    "",
    "Proposed record (as extracted):",
    JSON.stringify(args.proposed, null, 2),
  ].join("\n");
}

export interface VerifyStagedRecordArgs {
  model: LanguageModel;
  targetMaster: string;
  proposed: unknown;
  sourceText: string;
  filename: string;
  docDateISO: string | null;
}

/** Token usage for one verification call, normalized to plain numbers for llm_calls logging. */
export interface VerifyUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StagedVerifyResult extends StagedVerdict {
  usage: VerifyUsage;
}

/**
 * Run one verification pass over a proposed staged record. Temperature 0 — this
 * is an audit, not a creative task, and the same record should audit the same
 * way every time. Returns the verdict plus token usage for the cost ledger.
 */
export async function verifyStagedRecord(args: VerifyStagedRecordArgs): Promise<StagedVerifyResult> {
  const prompt = buildVerifyPrompt({
    targetMaster: args.targetMaster,
    proposed: args.proposed,
    sourceText: args.sourceText,
    filename: args.filename,
    docDateISO: args.docDateISO,
  });
  const { object, usage } = await generateObject({
    model: args.model,
    schema: stagedVerdictSchema,
    temperature: 0,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });
  return {
    verdict: object.verdict,
    confidence: object.confidence,
    issues: object.issues,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    },
  };
}
