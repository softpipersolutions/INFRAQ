/**
 * @pebble/engines — the deterministic core (spec B.01–B.03 + margin + totals).
 *
 * PURE: no I/O, no database, no LLM. Inputs are the enquiry-derived
 * GenerationInput and a resolved MasterSnapshot (integer paise); output is a
 * GenerationResult. Same inputs → identical output, always. This is the only
 * place a rupee figure is ever computed.
 */
export type { GenerationInput } from "./context";
export { buildExprContext, totalAreaSqm } from "./context";
export { generateBom, type BomResult } from "./bom";
export {
  priceBom,
  type PriceBomOptions,
  type PriceBomResult,
  type PricedLineWithCost,
} from "./pricing";
export { validateSitc, computeMargin, computeTotals } from "./finalize";
export { generateEstimate, ENGINE_VERSION, type GenerateOptions } from "./generate";
export {
  diffVersions,
  type VersionDiff,
  type ChangedLine,
  type FieldDelta,
} from "./diff";
