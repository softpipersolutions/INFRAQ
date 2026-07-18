import { describe, expect, it } from "vitest";
import type { ExprContext } from "@pebble/shared";
import { ExprError, evaluateAst, parseExpression, validateExpression } from "../src/index";

/**
 * Adversarial suite — the security backbone of @pebble/expr. Rule expressions
 * are authored by Greenberg staff and persisted, so both the parser (source in)
 * and the interpreter (stored AST in) must be hostile-input safe: no prototype
 * access, no member expressions, no foreign operators, no eval, and hard
 * node/depth caps that survive a corrupted or maliciously hand-crafted AST.
 *
 * Every case here must be REJECTED. A test that unexpectedly passes validation
 * or evaluates a hostile AST is a real vulnerability, not a flaky test.
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

/** Assert evaluateAst throws ExprError for a hostile AST; return the first issue code. */
function rejectionCode(ast: unknown): string {
  try {
    evaluateAst(ast, ctx);
  } catch (err) {
    expect(err).toBeInstanceOf(ExprError);
    return (err as ExprError).issues[0]?.code ?? "";
  }
  throw new Error("SECURITY: evaluateAst accepted a hostile AST");
}

describe("source-level rejection (validateExpression / parseExpression)", () => {
  const forbidden: Array<[string, string]> = [
    ["member access", "config.secret"],
    ["nested member access", "a.b.c"],
    ["computed member access", "ctx['floors_above']"],
    ["method call via member", "Math.floor(floor_area_sqm)"],
    ["prototype climb", "floors_above.constructor"],
    ["__proto__ access", "floors_above.__proto__"],
  ];
  it.each(forbidden)("%s is a FORBIDDEN_NODE: %s", (_label, src) => {
    const result = validateExpression(src, "quantity");
    expect(result.ok).toBe(false);
    expect(result.ast).toBeNull();
    expect(result.issues.map((i) => i.code)).toContain("FORBIDDEN_NODE");
  });

  const hostileIdentifiers = ["__proto__", "constructor", "prototype", "process", "globalThis"];
  it.each(hostileIdentifiers)("bare identifier %s is unknown, never a prototype hook", (name) => {
    const result = validateExpression(`${name} = 1`, "condition");
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("UNKNOWN_IDENTIFIER");
  });

  const foreignOperators = [
    "floors_above && 1",
    "floors_above || 1",
    "floors_above ?? 1",
    "floors_above & 1",
    "floors_above | 1",
    "floors_above ^ 1",
    "~floors_above",
    "2 ** 3",
    "floors_above === 1",
  ];
  it.each(foreignOperators)("foreign operator is rejected, never silently accepted: %s", (src) => {
    // Try both kinds — a truncated parse must not slip through as a valid quantity.
    expect(validateExpression(src, "quantity").ok).toBe(false);
    expect(validateExpression(src, "condition").ok).toBe(false);
  });

  it("assignment is not possible — '=' is equality, so no state can be mutated", () => {
    // `x = 1` parses as an equality comparison over an unknown identifier, not a write.
    const result = validateExpression("floors_above = 1", "condition");
    expect(result.ok).toBe(true); // it's a valid boolean comparison
    // …and it can only ever return a boolean, never assign.
    expect(typeof evaluateAst(parseExpression("floors_above = 1", "condition"), ctx)).toBe(
      "boolean",
    );
  });
});

describe("complexity caps at parse/validate time (DoS resistance)", () => {
  it("a node bomb is TOO_COMPLEX, not a hang", () => {
    const bomb = Array.from({ length: 150 }, () => "1").join(" + "); // ~299 nodes
    const result = validateExpression(bomb, "quantity");
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("TOO_COMPLEX");
  });

  it("a depth bomb is TOO_COMPLEX, not a stack overflow", () => {
    const bomb = "!".repeat(40) + "true"; // 41 deep, few nodes → isolates the depth cap
    const result = validateExpression(bomb, "condition");
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("TOO_COMPLEX");
  });

  it("pathological parenthesis nesting fails cleanly and never throws", () => {
    const bomb = "(".repeat(20000) + "1" + ")".repeat(20000);
    expect(() => validateExpression(bomb, "quantity")).not.toThrow();
    expect(validateExpression(bomb, "quantity").ok).toBe(false);
  });
});

describe("stored-AST rejection (evaluateAst re-checks everything)", () => {
  it("a MemberExpression node is forbidden even when hand-injected", () => {
    const ast = {
      type: "MemberExpression",
      computed: false,
      object: { type: "Identifier", name: "floors_above" },
      property: { type: "Identifier", name: "__proto__" },
    };
    expect(rejectionCode(ast)).toBe("FORBIDDEN_NODE");
  });

  it("a CallExpression whose callee is a member is forbidden", () => {
    const ast = {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "Math" },
        property: { type: "Identifier", name: "floor" },
      },
      arguments: [{ type: "Literal", value: 1 }],
    };
    expect(rejectionCode(ast)).toBe("FORBIDDEN_NODE");
  });

  it("a hostile MemberExpression smuggled in as a call argument is forbidden", () => {
    const ast = {
      type: "CallExpression",
      callee: { type: "Identifier", name: "CEIL" },
      arguments: [
        {
          type: "MemberExpression",
          computed: true,
          object: { type: "Identifier", name: "floors_above" },
          property: { type: "Literal", value: "constructor" },
        },
      ],
    };
    expect(rejectionCode(ast)).toBe("FORBIDDEN_NODE");
  });

  it("a __proto__ Identifier resolves to nothing (UNKNOWN_IDENTIFIER)", () => {
    expect(rejectionCode({ type: "Identifier", name: "__proto__" })).toBe("UNKNOWN_IDENTIFIER");
    expect(rejectionCode({ type: "Identifier", name: "constructor" })).toBe("UNKNOWN_IDENTIFIER");
  });

  const malformed: Array<[string, unknown]> = [
    ["null", null],
    ["a bare number", 42],
    ["a bare string", "floors_above"],
    ["an array", [{ type: "Literal", value: 1 }]],
    ["an object with no type", { value: 1 }],
    ["a non-string type", { type: 123 }],
    ["an unknown statement type", { type: "WhileStatement", test: { type: "Literal", value: true } }],
    ["an assignment node", {
      type: "AssignmentExpression",
      operator: "=",
      left: { type: "Identifier", name: "floors_above" },
      right: { type: "Literal", value: 0 },
    }],
  ];
  it.each(malformed)("rejects %s as a forbidden/malformed node", (_label, ast) => {
    expect(rejectionCode(ast)).toBe("FORBIDDEN_NODE");
  });

  it("re-enforces the depth cap on a hand-built AST", () => {
    let node: unknown = { type: "Literal", value: 1 };
    for (let i = 0; i < 40; i++) node = { type: "UnaryExpression", operator: "-", argument: node };
    expect(rejectionCode(node)).toBe("TOO_COMPLEX");
  });

  it("re-enforces the node cap on a hand-built balanced tree", () => {
    function balanced(depth: number): unknown {
      if (depth === 0) return { type: "Literal", value: 1 };
      return {
        type: "BinaryExpression",
        operator: "+",
        left: balanced(depth - 1),
        right: balanced(depth - 1),
      };
    }
    // depth 8 → 511 nodes, but only 9 deep: isolates the node cap from the depth cap.
    expect(rejectionCode(balanced(8))).toBe("TOO_COMPLEX");
  });

  it("division by zero in a stored AST throws rather than yielding Infinity", () => {
    const ast = {
      type: "BinaryExpression",
      operator: "/",
      left: { type: "Identifier", name: "floors_above" },
      right: { type: "Literal", value: 0 },
    };
    expect(() => evaluateAst(ast, ctx)).toThrow(ExprError);
  });
});
