/** Core business constants — spec B.03 and Format A. */

/** Target blended ratio: SITC = Supply × 1.43. */
export const SITC_TARGET_RATIO = 1.43;
/** Lower bound of the acceptable blended-ratio band (target − 5%…). */
export const SITC_MIN_RATIO = 1.35;
/** Upper bound of the acceptable blended-ratio band. */
export const SITC_MAX_RATIO = 1.51;

/** GST applied on the grand total in Format A output. */
export const GST_RATE = 0.18;

/** Historical house rule: proposals are valid 7 days ("raw material price fluctuations"). */
export const ESTIMATE_VALIDITY_DAYS = 7;

/** ID prefixes — GBE-ENQ-2025-001 / GBE-EST-2025-001. */
export const ENQUIRY_ID_PREFIX = "GBE-ENQ";
export const ESTIMATE_ID_PREFIX = "GBE-EST";

export function formatSequentialId(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(3, "0")}`;
}
