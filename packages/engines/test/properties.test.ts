import { SITC_MAX_RATIO, SITC_MIN_RATIO } from "@pebble/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeMargin, computeTotals, generateEstimate, validateSitc } from "../src/index";
import { DEMO_INPUT, counterUid, fixtureSnapshot } from "./fixtures";

/**
 * Property tests (fast-check) — the invariants that make the deterministic core
 * trustworthy across the whole input space, not just the golden fixture.
 */

const marginRow = {
  tier: 2,
  tierLabel: "₹5L–20L",
  targetMarginPct: 22,
  floorMarginPct: 15,
  discountAuthority: "GM" as const,
};

describe("engine invariants", () => {
  it("additivity: lineAmount = supplyAmount + installAmount for every generated line", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 1, max: 5000 }),
        (floorsAbove, floorAreaSqm) => {
          const gen = generateEstimate(
            { ...DEMO_INPUT, floorsAbove, floorAreaSqm },
            fixtureSnapshot(),
            { uid: counterUid() },
          );
          for (const l of gen.lines) {
            expect(l.lineAmountPaise).toBe(l.supplyAmountPaise + l.installAmountPaise);
            expect(l.sitcRatePaise).toBe(l.supplyRatePaise + l.installRatePaise);
          }
        },
      ),
    );
  });

  it("totals are the exact integer sum of lines, and grandTotal = SITC + GST", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 1, max: 5000 }), (fa, area) => {
        const gen = generateEstimate(
          { ...DEMO_INPUT, floorsAbove: fa, floorAreaSqm: area },
          fixtureSnapshot(),
          { uid: counterUid() },
        );
        const sumLines = gen.lines.reduce((s, l) => s + l.lineAmountPaise, 0);
        const sumSupply = gen.lines.reduce((s, l) => s + l.supplyAmountPaise, 0);
        expect(gen.totals.totalSitcPaise).toBe(sumLines);
        expect(gen.totals.totalSupplyPaise).toBe(sumSupply);
        expect(gen.totals.grandTotalPaise).toBe(gen.totals.totalSitcPaise + gen.totals.gstPaise);
      }),
    );
  });

  it("SITC status is PASS iff the reported blended ratio is within [1.35, 1.51]", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            supply: fc.integer({ min: 1, max: 10_000_000 }),
            install: fc.integer({ min: 0, max: 10_000_000 }),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        (rows) => {
          const lines = rows.map((r) => ({
            supplyAmountPaise: r.supply,
            installAmountPaise: r.install,
            lineAmountPaise: r.supply + r.install,
          }));
          const res = validateSitc(lines);
          const inBand =
            res.blendedRatio !== null &&
            res.blendedRatio >= SITC_MIN_RATIO &&
            res.blendedRatio <= SITC_MAX_RATIO;
          expect(res.status === "PASS").toBe(inBand);
        },
      ),
    );
  });

  it("order-invariance: shuffling snapshot arrays does not change the generation", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999 }), (seed) => {
        const base = generateEstimate(DEMO_INPUT, fixtureSnapshot(), { uid: counterUid() });
        const shuffled = fixtureSnapshot();
        const rng = mulberry32(seed);
        shuffle(shuffled.rules, rng);
        shuffle(shuffled.makes, rng);
        shuffle(shuffled.prices, rng);
        shuffle(shuffled.installRates, rng);
        shuffle(shuffled.materials, rng);
        const out = generateEstimate(DEMO_INPUT, shuffled, { uid: counterUid() });
        expect(out).toEqual(base);
      }),
    );
  });

  it("margin monotonicity: raising buying cost never raises the margin", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 500 }),
            supply: fc.integer({ min: 1000, max: 5_000_000 }),
            buy: fc.integer({ min: 0, max: 5_000_000 }),
            bump: fc.integer({ min: 0, max: 1_000_000 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (rows) => {
          const low = rows.map((r) => ({
            qty: r.qty,
            supplyAmountPaise: r.qty * r.supply,
            buyingRatePaise: r.buy,
          }));
          const high = rows.map((r) => ({
            qty: r.qty,
            supplyAmountPaise: r.qty * r.supply,
            buyingRatePaise: r.buy + r.bump,
          }));
          const mLow = computeMargin(low, marginRow).marginPct ?? 0;
          const mHigh = computeMargin(high, marginRow).marginPct ?? 0;
          expect(mHigh).toBeLessThanOrEqual(mLow + 1e-9);
        },
      ),
    );
  });

  it("computeTotals never drifts: GST is 18% of SITC, rounded once", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (sitcPaise) => {
        const totals = computeTotals({
          totalSupplyPaise: sitcPaise,
          totalInstallPaise: 0,
          totalSitcPaise: sitcPaise,
          blendedRatio: null,
          status: "ALERT",
        });
        expect(totals.gstPaise).toBe(Math.round(sitcPaise * 0.18));
        expect(totals.grandTotalPaise).toBe(sitcPaise + totals.gstPaise);
      }),
    );
  });
});

// Small deterministic PRNG + Fisher–Yates shuffle (Math.random is avoided so
// failures reproduce from the fast-check seed).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const ai = arr[i]!;
    const aj = arr[j]!;
    arr[i] = aj;
    arr[j] = ai;
  }
}
