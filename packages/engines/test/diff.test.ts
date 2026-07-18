import type { PricedLine } from "@pebble/shared";
import { describe, expect, it } from "vitest";
import { diffVersions } from "../src/index";

/** Version compare (join on line_uid) — added / removed / changed / unchanged. */

function line(uid: string, over: Partial<PricedLine> = {}): PricedLine {
  return {
    lineUid: uid,
    systemType: "FAS",
    sectionOrder: 0,
    lineOrder: 0,
    materialCode: "FAS-SMK-001",
    description: "Smoke Detector",
    makeCode: "SMK-STD",
    brandName: "Agni Devices",
    qty: 30,
    unit: "No.",
    supplyRatePaise: 145000,
    installRatePaise: 62350,
    sitcRatePaise: 207350,
    supplyAmountPaise: 4_350_000,
    installAmountPaise: 1_870_500,
    lineAmountPaise: 6_220_500,
    source: "RULE",
    ruleCode: "DL-FAS-001",
    priceId: "P-SMK-STD",
    installRateCode: "INST-FAS-SMK-001",
    installRateUnit: "Per No.",
    note: null,
    editReason: null,
    ...over,
  };
}

describe("diffVersions", () => {
  it("classifies added, removed, changed and unchanged lines by line_uid", () => {
    const v1 = [line("a"), line("b"), line("c")];
    const v2 = [
      line("a"), // unchanged
      line("b", { qty: 32, supplyAmountPaise: 4_640_000, lineAmountPaise: 6_635_200 }), // changed
      line("d"), // added
      // "c" removed
    ];
    const diff = diffVersions(v1, v2);
    expect(diff.added.map((l) => l.lineUid)).toEqual(["d"]);
    expect(diff.removed.map((l) => l.lineUid)).toEqual(["c"]);
    expect(diff.changed.map((l) => l.lineUid)).toEqual(["b"]);
    expect(diff.unchanged.map((l) => l.lineUid)).toEqual(["a"]);
  });

  it("reports field-level deltas for a changed line", () => {
    const diff = diffVersions([line("a", { qty: 30 })], [line("a", { qty: 40 })]);
    const changed = diff.changed[0];
    expect(changed?.lineUid).toBe("a");
    expect(changed?.deltas.find((d) => d.field === "qty")).toEqual({ field: "qty", before: 30, after: 40 });
  });

  it("is empty when nothing changed", () => {
    const same = [line("a"), line("b")];
    const diff = diffVersions(same, same.map((l) => ({ ...l })));
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toHaveLength(2);
  });
});
