import type {
  EstimateTotals,
  MarginResult,
  MarginRow,
  PricedLine,
  SitcResult,
} from "@pebble/shared";
import {
  GST_RATE,
  SITC_MAX_RATIO,
  SITC_MIN_RATIO,
  applyPct,
  lineAmount,
  sumPaise,
} from "@pebble/shared";

/** Round to 4 decimals (blended ratio precision — matches NUMERIC(8,4)). */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
/** Round to 2 decimals (margin percent precision — matches NUMERIC(6,2)). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type SupplyInstallLine = Pick<PricedLine, "supplyAmountPaise" | "installAmountPaise" | "lineAmountPaise">;

/**
 * B.03 — SITC validation. blendedRatio = total SITC / total supply (null when
 * supply is zero). PASS iff the ratio is within the [1.35, 1.51] acceptance
 * band. The status is derived from the same rounded ratio that is reported, so
 * "PASS iff ratio in band" holds exactly.
 */
export function validateSitc(lines: readonly SupplyInstallLine[]): SitcResult {
  const totalSupplyPaise = sumPaise(lines.map((l) => l.supplyAmountPaise));
  const totalInstallPaise = sumPaise(lines.map((l) => l.installAmountPaise));
  const totalSitcPaise = sumPaise(lines.map((l) => l.lineAmountPaise));
  const blendedRatio = totalSupplyPaise === 0 ? null : round4(totalSitcPaise / totalSupplyPaise);
  const status =
    blendedRatio !== null && blendedRatio >= SITC_MIN_RATIO && blendedRatio <= SITC_MAX_RATIO
      ? "PASS"
      : "ALERT";
  return { totalSupplyPaise, totalInstallPaise, totalSitcPaise, blendedRatio, status };
}

type MarginLine = { qty: number; supplyAmountPaise: number; buyingRatePaise: number };

/**
 * Margin gate — computed on **supply only** (installation is pass-through
 * labour). sell = Σ supply amounts, buy = Σ (qty × buying rate). Below the
 * tier's floor margin → BELOW_FLOOR, and the tier's discount authority must
 * approve the exception.
 */
export function computeMargin(lines: readonly MarginLine[], marginRow: MarginRow): MarginResult {
  const sell = sumPaise(lines.map((l) => l.supplyAmountPaise));
  const buy = sumPaise(lines.map((l) => lineAmount(l.qty, l.buyingRatePaise)));
  if (sell === 0) {
    return { marginPct: null, status: "OK", requiredAuthority: null };
  }
  const preciseMargin = ((sell - buy) / sell) * 100;
  const belowFloor = preciseMargin < marginRow.floorMarginPct;
  return {
    marginPct: round2(preciseMargin),
    status: belowFloor ? "BELOW_FLOOR" : "OK",
    requiredAuthority: belowFloor ? marginRow.discountAuthority : null,
  };
}

/** Totals + GST rollup (Format A): gst = 18% of total SITC. */
export function computeTotals(sitc: SitcResult): EstimateTotals {
  const gstPaise = applyPct(sitc.totalSitcPaise, GST_RATE * 100);
  return {
    totalSupplyPaise: sitc.totalSupplyPaise,
    totalInstallPaise: sitc.totalInstallPaise,
    totalSitcPaise: sitc.totalSitcPaise,
    gstPaise,
    grandTotalPaise: sitc.totalSitcPaise + gstPaise,
    blendedRatio: sitc.blendedRatio,
  };
}
