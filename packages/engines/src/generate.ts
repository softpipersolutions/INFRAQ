import type { GenerationResult, MasterSnapshot, PricedLine } from "@pebble/shared";
import { generateBom } from "./bom";
import type { GenerationInput } from "./context";
import { computeMargin, computeTotals, validateSitc } from "./finalize";
import { priceBom, type PriceBomOptions } from "./pricing";

/** Semantic version of the deterministic engine set — pinned in every snapshot. */
export const ENGINE_VERSION = "b-1.0.0";

export type GenerateOptions = PriceBomOptions;

/**
 * Compose B.01 → B.02 → B.03 → margin → totals into one deterministic
 * generation. Given the same enquiry input, MasterSnapshot and uid factory, the
 * output is byte-for-byte identical (the golden-test guarantee). LLMs never
 * enter this path — every rupee here comes from the pure engines.
 */
export function generateEstimate(
  input: GenerationInput,
  snapshot: MasterSnapshot,
  options: GenerateOptions = {},
): GenerationResult {
  const bom = generateBom(input, snapshot);
  const priced = priceBom(bom.lines, input, snapshot, options);

  const sitc = validateSitc(priced.lines);

  const marginRow = snapshot.marginMatrix.find((m) => m.tier === input.projectTier);
  if (!marginRow) {
    throw new Error(`No margin matrix row for project tier ${input.projectTier}`);
  }
  const margin = computeMargin(priced.lines, marginRow);
  const totals = computeTotals(sitc);

  // Strip the internal buying cost from the persisted/returned lines.
  const lines: PricedLine[] = priced.lines.map(({ buyingRatePaise: _drop, ...line }) => line);

  const ruleIds = [...new Set(bom.appliedRules.map((r) => r.ruleId))];

  return {
    lines,
    appliedRules: bom.appliedRules,
    warnings: [...bom.warnings, ...priced.warnings],
    sitc,
    margin,
    totals,
    snapshot: {
      ruleIds,
      priceIds: priced.priceIds,
      installRateCodes: priced.installRateCodes,
      marginTier: input.projectTier,
      engineVersion: ENGINE_VERSION,
    },
  };
}
