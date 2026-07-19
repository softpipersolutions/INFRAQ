import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { INTENTS, type Intent } from "./router";
import { extractionSchema, type ExtractedFields, type SlotState, SLOT_FIELDS } from "./slots";

/**
 * The Gemini retrieval/extraction lane's two model calls (spec §4.4):
 *   - extractEnquiryFields: pull newly-mentioned A.08 fields from a message
 *   - classifyIntent: the cheap enum classification the router uses
 *
 * Both take the model by injection so orchestration is testable with a stub;
 * the prompt builders are pure and are what the unit tests cover.
 */

/** Compact summary of what's already known, so the model extracts only new info. */
function knownSummary(state: SlotState): string {
  const known = SLOT_FIELDS.filter((f) => state[f].status !== "missing").map(
    (f) => `${f}=${JSON.stringify(state[f].value)} (${state[f].status})`,
  );
  return known.length ? known.join(", ") : "(nothing captured yet)";
}

export function buildExtractionPrompt(userMessage: string, state: SlotState): string {
  return [
    "Extract fire-safety enquiry fields (A.08) that the user states or clearly implies in their latest message.",
    "Only include fields that are NEWLY mentioned or corrected; omit everything else. Do not guess.",
    "Normalise: building type and systems to the canonical enum spelling; areas/floors to numbers.",
    "floorAreaSqm is the area of ONE typical floor, never the building total: " +
      "'450 sqm per floor' → 450. If the user only gives a total for N floors, divide by N. " +
      "When the user corrects an earlier value, emit the corrected value.",
    "",
    `Already captured: ${knownSummary(state)}`,
    "",
    `Latest message: """${userMessage}"""`,
  ].join("\n");
}

/** Extract newly-mentioned enquiry fields from a user message via the Gemini lane. */
export async function extractEnquiryFields(args: {
  model: LanguageModel;
  userMessage: string;
  state: SlotState;
}): Promise<ExtractedFields> {
  const { object } = await generateObject({
    model: args.model,
    schema: extractionSchema,
    prompt: buildExtractionPrompt(args.userMessage, args.state),
  });
  return object;
}

const intentClassificationSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
});

export function buildClassificationPrompt(message: string): string {
  return [
    "Classify the user's intent for a fire-safety estimating assistant into exactly one label:",
    "- LOOKUP: fetch a specific master fact (a material, make, or price)",
    "- EXTRACT: state enquiry details to capture",
    "- RECALL: ask what was quoted before / historical retrieval",
    "- INTERPRET: open-ended interpretation of requirements",
    "- DRAFT_ASSIST: help shaping or adjusting a draft estimate",
    "- EXPLAIN: ask why a line/quantity/rate is what it is",
    "- COMPUTE: request a (re)calculation of prices/quantities/totals",
    "- SLOT_FILL: continue an in-progress enquiry capture",
    "Return the label and a confidence in [0,1].",
    "",
    `Message: """${message}"""`,
  ].join("\n");
}

/** Router classifier backed by the Gemini lane. */
export async function classifyIntent(
  model: LanguageModel,
  message: string,
): Promise<{ intent: Intent; confidence: number }> {
  const { object } = await generateObject({
    model,
    schema: intentClassificationSchema,
    prompt: buildClassificationPrompt(message),
  });
  return object;
}
