import { describe, expect, it } from "vitest";
import {
  MoneyError,
  applyPct,
  formatINR,
  lineAmount,
  paiseToNumericString,
  paiseToRupees,
  roundHalfUp,
  sumPaise,
  toPaise,
} from "../src/money";

/**
 * The money discipline is load-bearing for the whole platform: engines compute
 * in integer paise, round half-up exactly once per line, and sum exactly. These
 * tests pin those invariants.
 */

describe("toPaise / paiseToRupees", () => {
  it("converts rupees (number or NUMERIC string) to integer paise", () => {
    expect(toPaise(1450)).toBe(145000);
    expect(toPaise("1450.00")).toBe(145000);
    expect(toPaise("623.50")).toBe(62350);
  });
  it("absorbs 2dp representation error via half-up rounding", () => {
    expect(toPaise(14.505)).toBe(1451); // 1450.5 → 1451
    expect(toPaise(0.1 + 0.2)).toBe(30); // 0.30000000000000004 → 30
  });
  it("round-trips paise back to rupees", () => {
    expect(paiseToRupees(145000)).toBe(1450);
  });
  it("throws on non-finite input", () => {
    expect(() => toPaise(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => toPaise("not-a-number")).toThrow(MoneyError);
  });
});

describe("roundHalfUp", () => {
  it("rounds .5 away from zero (commercial convention)", () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(2.4)).toBe(2);
    expect(roundHalfUp(2.6)).toBe(3);
  });
});

describe("lineAmount (the single rounding point)", () => {
  it("computes qty × rate in paise, rounded half-up", () => {
    expect(lineAmount(30, 145000)).toBe(4_350_000);
    expect(lineAmount(2700, 3655)).toBe(9_868_500);
  });
  it("rounds fractional quantities once", () => {
    expect(lineAmount(0.5, 145001)).toBe(72_501); // 72500.5 → 72501
  });
  it("rejects a negative quantity", () => {
    expect(() => lineAmount(-1, 100)).toThrow(MoneyError);
  });
  it("is additive — the SITC invariant supply + install = line", () => {
    const supply = lineAmount(9, 210000);
    const install = lineAmount(9, 90300);
    expect(supply + install).toBe(lineAmount(9, 210000 + 90300));
  });
});

describe("sumPaise / applyPct", () => {
  it("sums exactly as integers", () => {
    expect(sumPaise([1, 2, 3, 4])).toBe(10);
    expect(sumPaise([])).toBe(0);
  });
  it("throws on an unsafe value", () => {
    expect(() => sumPaise([Number.MAX_SAFE_INTEGER, 1])).toThrow(MoneyError);
  });
  it("applies a percentage with half-up rounding (18% GST)", () => {
    expect(applyPct(41_741_700, 18)).toBe(7_513_506);
    expect(applyPct(100, 50)).toBe(50);
  });
});

describe("formatINR (Indian digit grouping)", () => {
  it("groups lakhs/crores correctly", () => {
    expect(formatINR(145000)).toBe("₹ 1,450.00");
    expect(formatINR(12_34_56_789_00)).toBe("₹ 12,34,56,789.00");
    expect(formatINR(50)).toBe("₹ 0.50");
  });
  it("handles negatives and the symbol toggle", () => {
    expect(formatINR(-500)).toBe("-₹ 5.00");
    expect(formatINR(145000, { symbol: false })).toBe("1,450.00");
  });
});

describe("paiseToNumericString (NUMERIC(14,2) writes)", () => {
  it("always emits two decimals", () => {
    expect(paiseToNumericString(145000)).toBe("1450.00");
    expect(paiseToNumericString(5)).toBe("0.05");
    expect(paiseToNumericString(-5)).toBe("-0.05");
  });
});
