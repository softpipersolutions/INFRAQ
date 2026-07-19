import { generateObject, type LanguageModel } from "ai";
import { extractionSchema, type ExtractedFields, type SlotState, SLOT_FIELDS } from "./slots";

/**
 * The Gemini extraction call (spec §4.4): `extractEnquiryFields` pulls
 * newly-mentioned A.08 fields from a message.
 *
 * The model is injected so orchestration is testable with a stub; the prompt
 * builder is pure and is what the unit tests cover.
 *
 * NOTE (Phase C.5): the pre-triage intent classifier (`classifyIntent` /
 * `buildClassificationPrompt`) has been deleted — the Sonnet-5 agent routes
 * itself via tool choice, so there are no lanes to pick. Gemini Flash's
 * remaining jobs are field extraction (here), embeddings and summary compaction.
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
    "You extract fire-safety enquiry fields (A.08) from a user's latest message in an ongoing chat.",
    "Return a value for EVERY field this message provides or corrects — do not miss a stated value.",
    "But NEVER invent a value the user has not given. If a field is not addressed in this message, omit it.",
    "",
    "How the user's words map to fields:",
    '- "N floors" / "N-storey" / "N storeys" / "G+N" → floorsAbove = N',
    '- "X sqm per floor" / "each floor is X sqm" / "X square metres" → floorAreaSqm = X (ONE floor, never the total; if only a total for N floors is given, divide by N)',
    '- building use (office/shop/mall/showroom → Commercial; flats/apartments → Residential; factory/warehouse → Industrial; school/hospital → Institutional) → buildingType',
    '- "fire alarm"/"detection" → "FAS"; "hydrant"/"riser"/"hose reel" → "Hydrant"; "sprinkler" → "Sprinkler"; "extinguisher" → "Extinguisher"; "suppression"/"clean agent"/"gas system" → "Suppression". systemsRequired is the EXACT set the client named — never add a system they did not ask for.',
    '- "standard makes" → "Standard"; "premium"/"branded" → "Premium"; "economy"/"cheapest" → "Economy"; "as per Greenberg"/"your choice"/"you decide" → "As per Greenberg"',
    '- "tier N" / "grade N" (1-4) → projectTier = N. If the user has NOT said a tier, OMIT projectTier entirely — do not guess 1.',
    '- IS / Indian standards → applicableStandard = "IS"',
    "",
    "Worked example — message: \"office block, 8 floors, 500 sqm each floor, need fire alarm and sprinklers, standard makes\"",
    '  → {"buildingType":"Commercial","floorsAbove":8,"floorAreaSqm":500,"systemsRequired":["FAS","Sprinkler"],"makePreference":"Standard"}',
    "  (note: no projectTier, no clientName — they were not stated)",
    "",
    `Already captured (do not re-ask; only add/correct): ${knownSummary(state)}`,
    "",
    `Latest message: """${userMessage}"""`,
  ].join("\n");
}

/**
 * Drop model-hallucinated values that the message does not actually support.
 *
 * `projectTier` is the persistent offender: Gemini almost always fills it with
 * `1` even when no tier was stated (and getting the tier wrong silently picks
 * the wrong margin band). No prompt reliably suppresses it, so we gate it in
 * code: keep an extracted tier only when the message plainly signals one —
 * contains "tier"/"grade", or is essentially a bare 1-4 answer to a tier
 * question. Everything else passes through untouched.
 */
export function guardExtractedFields(
  extracted: ExtractedFields,
  userMessage: string,
): ExtractedFields {
  if (extracted.projectTier === undefined) return extracted;
  const msg = userMessage.trim();
  const mentionsTier = /\b(tier|grade|category)\b/i.test(msg);
  const bareAnswer = /^(tier\s*)?[1-4]$/i.test(msg);
  if (mentionsTier || bareAnswer) return extracted;
  const { projectTier: _dropped, ...rest } = extracted;
  return rest;
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
    // Deterministic, non-creative: extraction must transcribe, not embellish
    // (temperature > 0 is what lets the model "complete" the systems enum).
    temperature: 0,
    prompt: buildExtractionPrompt(args.userMessage, args.state),
  });
  return guardExtractedFields(object, args.userMessage);
}
