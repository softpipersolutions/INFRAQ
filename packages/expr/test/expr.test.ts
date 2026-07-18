import { describe, expect, it } from "vitest";
import type { ExprContext } from "@pebble/shared";
import {
  ExprError,
  evaluateAst,
  evaluateCondition,
  evaluateQuantity,
  parseExpression,
  validateExpression,
} from "../src/index";

/**
 * Functional suite for @pebble/expr — the safe rule-expression engine (A.06).
 * Covers the public contract: validateExpression / parseExpression /
 * evaluateCondition / evaluateQuantity / evaluateAst, every operator and
 * function, comparison + type semantics, and the diagnostic issue codes.
 * Adversarial rejection (member access, __proto__, node/depth bombs) lives in
 * adversarial.test.ts.
 */

const ctx: ExprContext = {
  building_type: "Commercial",
  floors_above: 4,
  floor_area_sqm: 450,
  total_area_sqm: 1800,
  system: "FAS",
  make_preference: "As per Greenberg",
  applicable_standard: "NBC 2016",
  project_tier: 2,
};

function issueCodes(src: string, kind: "condition" | "quantity"): string[] {
  return validateExpression(src, kind).issues.map((i) => i.code);
}

describe("validateExpression — well-formed expressions accepted", () => {
  const validConditions = [
    "building_type = Commercial",
    "building_type = Commercial AND floor_area_sqm <= 500",
    "floors_above >= 4 OR total_area_sqm > 1000",
    "NOT (system = Hydrant)",
    "system <> FAS",
    "project_tier >= 2 AND project_tier <= 4",
    "make_preference = As_per_Greenberg",
    "applicable_standard = NBC_2016",
    "true",
    "floor_area_sqm > 0 AND (building_type = Commercial OR building_type = Industrial)",
  ];
  it.each(validConditions)("condition ok: %s", (src) => {
    const result = validateExpression(src, "condition");
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(result.ast).not.toBeNull();
  });

  const validQuantities = [
    "CEIL(total_area_sqm / 60)",
    "FLOOR(floor_area_sqm / 100)",
    "ROUND(total_area_sqm / 45)",
    "MAX(1, CEIL(total_area_sqm / 200))",
    "MIN(floors_above, 10)",
    "CLAMP(total_area_sqm / 500, 1, 8)",
    "IF(floors_above >= 4, 2, 1)",
    "floors_above * 2 + 1",
    "42",
  ];
  it.each(validQuantities)("quantity ok: %s", (src) => {
    const result = validateExpression(src, "quantity");
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(result.ast).not.toBeNull();
  });
});

describe("evaluateCondition — boolean semantics", () => {
  const cases: Array<[string, boolean]> = [
    ["building_type = Commercial", true],
    ["building_type = Residential", false],
    ["building_type <> Residential", true],
    ["floor_area_sqm <= 500", true],
    ["floor_area_sqm < 450", false],
    ["floor_area_sqm >= 450", true],
    ["floors_above > 4", false],
    ["floors_above >= 4 AND building_type = Commercial", true],
    ["floors_above > 4 AND building_type = Commercial", false],
    ["floors_above > 4 OR building_type = Commercial", true],
    ["NOT (building_type = Residential)", true],
    ["NOT (building_type = Commercial)", false], // NOT binds tighter than =, so parens are required
    ["!(floors_above > 10)", true],
    ["system = FAS", true],
    ["system = fas", true], // enum words are case-insensitive
    ["make_preference = As_per_Greenberg", true],
    ["applicable_standard = NBC_2016", true],
    ["project_tier = 2", true],
    ["building_type = 'Commercial'", true], // quoted literal
    ["building_type = 'Warehouse'", false], // quoted literal not in vocabulary is still valid
  ];
  it.each(cases)("%s → %s", (src, expected) => {
    expect(evaluateCondition(src, ctx)).toBe(expected);
  });

  it("ternary and IF yield the taken branch", () => {
    expect(evaluateCondition("IF(floors_above >= 4, true, false)", ctx)).toBe(true);
    expect(evaluateCondition("floors_above >= 4 ? true : false", ctx)).toBe(true);
  });
});

describe("evaluateQuantity — numeric semantics", () => {
  const cases: Array<[string, number]> = [
    ["CEIL(total_area_sqm / 60)", 30], // 1800/60 = 30
    ["CEIL(total_area_sqm / 61)", 30], // 29.5… → 30
    ["FLOOR(total_area_sqm / 61)", 29],
    ["ROUND(total_area_sqm / 61)", 30], // 29.5 → 30 (half-up)
    ["ROUND(total_area_sqm / 63)", 29], // 28.57 → 29
    ["MIN(floors_above, 10)", 4],
    ["MAX(floors_above, 10)", 10],
    ["MAX(1, 2, 3, 4)", 4],
    ["MIN(5, 3, 9)", 3],
    ["CLAMP(100, 1, 8)", 8],
    ["CLAMP(0, 1, 8)", 1],
    ["CLAMP(5, 1, 8)", 5],
    ["IF(floors_above >= 4, 2, 1)", 2],
    ["IF(floors_above > 4, 2, 1)", 1],
    ["floors_above * 2 + 1", 9],
    ["total_area_sqm - floor_area_sqm", 1350],
    ["total_area_sqm % 60", 0],
    ["-floors_above + 10", 6],
    ["0", 0], // zero is a valid quantity
  ];
  it.each(cases)("%s → %d", (src, expected) => {
    expect(evaluateQuantity(src, ctx)).toBe(expected);
  });

  it("ROUND is commercial half-up (away from zero)", () => {
    expect(evaluateQuantity("ROUND(25 / 10)", ctx)).toBe(3); // 2.5 → 3
    expect(evaluateQuantity("ROUND(24 / 10)", ctx)).toBe(2); // 2.4 → 2
  });
});

describe("function table", () => {
  it("accepts case-insensitive names and canonicalizes them in the stored AST", () => {
    const ast = parseExpression("ceil(total_area_sqm / 60)", "quantity") as {
      callee: { name: string };
    };
    expect(ast.callee.name).toBe("CEIL");
  });

  it("CLAMP rejects an inverted range at runtime", () => {
    expect(() => evaluateQuantity("CLAMP(5, 8, 1)", ctx)).toThrow(ExprError);
  });

  it("MIN/MAX require at least two arguments", () => {
    expect(issueCodes("MIN(1)", "quantity")).toContain("TYPE_MISMATCH");
    expect(issueCodes("MAX(1)", "quantity")).toContain("TYPE_MISMATCH");
  });

  it("CEIL/FLOOR/ROUND require exactly one argument", () => {
    expect(issueCodes("CEIL(1, 2)", "quantity")).toContain("TYPE_MISMATCH");
  });

  it("IF requires a boolean condition and matching branch types", () => {
    expect(issueCodes("IF(5, 1, 2)", "quantity")).toContain("TYPE_MISMATCH");
    expect(issueCodes("IF(floors_above > 1, 1, building_type)", "quantity")).toContain(
      "TYPE_MISMATCH",
    );
  });
});

describe("comparison + equality semantics", () => {
  it("strings compare case-insensitively and trimmed", () => {
    expect(evaluateCondition("building_type = 'commercial'", ctx)).toBe(true);
    expect(evaluateCondition("building_type = '  COMMERCIAL  '", ctx)).toBe(true);
  });

  it("numbers compare numerically", () => {
    expect(evaluateCondition("project_tier = 2", ctx)).toBe(true);
    expect(evaluateCondition("project_tier <> 3", ctx)).toBe(true);
  });

  it("cross-type comparison is a validation type error", () => {
    expect(issueCodes("building_type = 5", "condition")).toContain("TYPE_MISMATCH");
    expect(issueCodes("floors_above = Commercial", "condition")).toContain("TYPE_MISMATCH");
  });

  it("boolean equality is rejected", () => {
    expect(issueCodes("(floors_above > 1) = (floor_area_sqm > 1)", "condition")).toContain(
      "TYPE_MISMATCH",
    );
  });

  it("relational operators require numbers", () => {
    expect(issueCodes("building_type < Commercial", "condition")).toContain("TYPE_MISMATCH");
  });
});

describe("arithmetic edge cases", () => {
  it("division by zero throws at evaluation", () => {
    expect(() => evaluateQuantity("floors_above / 0", ctx)).toThrow(ExprError);
  });
  it("modulo by zero throws at evaluation", () => {
    expect(() => evaluateQuantity("floors_above % 0", ctx)).toThrow(ExprError);
  });
});

describe("short-circuit evaluation", () => {
  it("AND does not evaluate the right side when the left is false", () => {
    // 1/0 would throw if evaluated; the left operand is false so it must not be.
    expect(evaluateCondition("floors_above > 10 AND (1 / 0 > 0)", ctx)).toBe(false);
  });
  it("OR does not evaluate the right side when the left is true", () => {
    expect(evaluateCondition("floors_above > 0 OR (1 / 0 > 0)", ctx)).toBe(true);
  });
  it("IF only evaluates the taken branch", () => {
    expect(evaluateQuantity("IF(floors_above > 0, 7, 1 / 0)", ctx)).toBe(7);
  });
});

describe("diagnostic issue codes", () => {
  it("empty source → PARSE_ERROR", () => {
    expect(issueCodes("", "condition")).toEqual(["PARSE_ERROR"]);
    expect(issueCodes("   ", "condition")).toEqual(["PARSE_ERROR"]);
  });
  it("unknown identifier → UNKNOWN_IDENTIFIER", () => {
    expect(issueCodes("wingspan > 3", "condition")).toContain("UNKNOWN_IDENTIFIER");
  });
  it("unknown function → UNKNOWN_FUNCTION", () => {
    expect(issueCodes("SQRT(floor_area_sqm)", "quantity")).toContain("UNKNOWN_FUNCTION");
  });
  it("wrong root type → TYPE_MISMATCH", () => {
    // a number where a condition is required
    expect(issueCodes("floor_area_sqm", "condition")).toContain("TYPE_MISMATCH");
    // a boolean where a quantity is required
    expect(issueCodes("floor_area_sqm > 1", "quantity")).toContain("TYPE_MISMATCH");
  });
  it("validateExpression never throws, even on garbage", () => {
    expect(() => validateExpression(")(*&^%", "condition")).not.toThrow();
    expect(validateExpression(")(*&^%", "condition").ok).toBe(false);
  });
});

describe("parseExpression", () => {
  it("throws an ExprError carrying issues on invalid input", () => {
    try {
      parseExpression("floor_area_sqm >", "condition");
      throw new Error("expected parseExpression to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExprError);
      expect((err as ExprError).issues.length).toBeGreaterThan(0);
    }
  });
  it("returns an AST that round-trips through JSON and replays identically", () => {
    const ast = parseExpression("CEIL(total_area_sqm / 60)", "quantity");
    const stored = JSON.parse(JSON.stringify(ast)); // mimic DB persistence
    expect(evaluateAst(stored, ctx)).toBe(30);
  });
});

describe("evaluateAst — replay of a validated AST", () => {
  it("evaluates a stored condition AST", () => {
    const ast = parseExpression("building_type = Commercial AND floors_above >= 4", "condition");
    expect(evaluateAst(ast, ctx)).toBe(true);
  });
  it("rejects a non-object context", () => {
    const ast = parseExpression("true", "condition");
    // @ts-expect-error — deliberately wrong context
    expect(() => evaluateAst(ast, null)).toThrow(ExprError);
  });
});
