/**
 * Money discipline for the deterministic engines:
 * - Postgres stores NUMERIC(14,2) rupees.
 * - Engines compute in INTEGER PAISE (1 rupee = 100 paise) as plain numbers.
 * - Rounding happens exactly once per line (half-up), totals are exact integer sums.
 *
 * Number.MAX_SAFE_INTEGER paise ≈ ₹90 trillion — far beyond this domain, but
 * every operation still asserts safe-integer results.
 */

export type Paise = number;

export class MoneyError extends Error {}

function assertSafeInt(n: number, ctx: string): void {
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new MoneyError(`Unsafe money value in ${ctx}: ${n}`);
  }
}

/** Parse a rupee amount (number or NUMERIC string from pg) into integer paise. */
export function toPaise(rupees: number | string, ctx = "toPaise"): Paise {
  const n = typeof rupees === "string" ? Number(rupees) : rupees;
  if (!Number.isFinite(n)) throw new MoneyError(`Invalid rupee amount in ${ctx}: ${rupees}`);
  // Round to the nearest paise to absorb 2dp decimal representation error.
  const p = roundHalfUp(n * 100);
  assertSafeInt(p, ctx);
  return p;
}

/** Integer paise → rupee number (safe for display / NUMERIC(14,2) writes). */
export function paiseToRupees(paise: Paise): number {
  assertSafeInt(paise, "paiseToRupees");
  return paise / 100;
}

/** Rupee string with exactly 2 decimals for NUMERIC columns. */
export function paiseToNumericString(paise: Paise): string {
  assertSafeInt(paise, "paiseToNumericString");
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}${rupees}.${String(rem).padStart(2, "0")}`;
}

/** Half-up rounding (0.5 rounds away from zero for positives — the commercial convention). */
export function roundHalfUp(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n) + Number.EPSILON);
}

/**
 * Line amount = qty × rate, rounded half-up to integer paise — the single
 * rounding point in the whole computation chain.
 */
export function lineAmount(qty: number, ratePaise: Paise, ctx = "lineAmount"): Paise {
  if (!Number.isFinite(qty) || qty < 0) throw new MoneyError(`Invalid qty in ${ctx}: ${qty}`);
  assertSafeInt(ratePaise, ctx);
  const amount = roundHalfUp(qty * ratePaise);
  assertSafeInt(amount, ctx);
  return amount;
}

/** Exact integer sum of paise values. */
export function sumPaise(values: readonly Paise[], ctx = "sumPaise"): Paise {
  let total = 0;
  for (const v of values) {
    assertSafeInt(v, ctx);
    total += v;
  }
  assertSafeInt(total, ctx);
  return total;
}

/** Apply a percentage (e.g. margin, GST) to a paise amount, rounding half-up. */
export function applyPct(paise: Paise, pct: number, ctx = "applyPct"): Paise {
  assertSafeInt(paise, ctx);
  if (!Number.isFinite(pct)) throw new MoneyError(`Invalid pct in ${ctx}: ${pct}`);
  const result = roundHalfUp(paise * (pct / 100));
  assertSafeInt(result, ctx);
  return result;
}

/**
 * Format integer paise as Indian-grouped rupees: 12345678900 → "₹ 12,34,56,789.00".
 */
export function formatINR(paise: Paise, opts: { symbol?: boolean } = {}): string {
  const { symbol = true } = opts;
  assertSafeInt(paise, "formatINR");
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  const s = String(rupees);
  let grouped: string;
  if (s.length <= 3) {
    grouped = s;
  } else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
  }
  return `${sign}${symbol ? "₹ " : ""}${grouped}.${rem}`;
}
