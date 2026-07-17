import { roundHalfUp } from "@pebble/shared";
import type { ExprContext } from "@pebble/shared";
import { ExprError, fail } from "./errors";
import {
  ARITHMETIC_OPS,
  EQUALITY_OPS,
  LOGICAL_OPS,
  MAX_DEPTH,
  MAX_NODES,
  NOT_OPS,
  RELATIONAL_OPS,
} from "./grammar";
import {
  IDENTIFIER_TYPES,
  isContextIdentifier,
  resolveEnumWord,
  resolveFunctionName,
} from "./resolve";

/**
 * AST interpreter. Fully defensive: the AST parameter is `unknown` because
 * stored rule ASTs come back from the database — every node is re-checked
 * against the whitelist, every name re-resolved through Maps (never a
 * prototype chain), and depth/size limits are enforced again so a hostile
 * or corrupted AST cannot run away.
 *
 * Semantics (spec A.06):
 * - '=' / '==' and '<>' / '!=': numbers numerically, strings
 *   case-insensitively (trimmed). No cross-type or boolean equality.
 * - < <= > >= and + - * / %: numbers only. Division/modulo by zero throws.
 * - AND / OR / NOT: booleans only (no truthiness); AND/OR short-circuit.
 * - IF and ?: evaluate only the taken branch.
 */

type Value = number | boolean | string;

interface EvalState {
  visited: number;
}

/** A plain-object AST node with a string `type`. */
interface NodeShape {
  type: string;
  [key: string]: unknown;
}

function asNode(value: unknown): NodeShape {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { type?: unknown }).type !== "string"
  ) {
    fail("FORBIDDEN_NODE", "Malformed AST node (expected an object with a string type)");
  }
  return value as NodeShape;
}

function requireBoolean(value: Value, where: string): boolean {
  if (typeof value !== "boolean") {
    fail("TYPE_MISMATCH", `${where} requires a boolean, got ${typeof value}`);
  }
  return value;
}

function requireNumber(value: Value, where: string): number {
  if (typeof value !== "number") {
    fail("TYPE_MISMATCH", `${where} requires a number, got ${typeof value}`);
  }
  if (!Number.isFinite(value)) {
    fail("TYPE_MISMATCH", `${where} produced a non-finite number`);
  }
  return value;
}

/** Resolve an Identifier node to its runtime value. */
function resolveIdentifier(name: unknown, ctx: ExprContext): Value {
  if (typeof name !== "string") {
    fail("FORBIDDEN_NODE", "Malformed Identifier node (name is not a string)");
  }
  if (isContextIdentifier(name)) {
    const value: unknown = ctx[name];
    const expected = IDENTIFIER_TYPES[name];
    if (expected === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail("TYPE_MISMATCH", `Context value for "${name}" must be a finite number, got ${String(value)}`);
      }
      return value;
    }
    if (typeof value !== "string") {
      fail("TYPE_MISMATCH", `Context value for "${name}" must be a string, got ${String(value)}`);
    }
    return value;
  }
  const enumValue = resolveEnumWord(name);
  if (enumValue !== null) return enumValue;
  fail("UNKNOWN_IDENTIFIER", `Unknown identifier "${name}"`);
}

/** Case-insensitive, trimmed string equality (spec A.06 comparison rule). */
function stringEq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function evalEquality(operator: string, left: Value, right: Value): boolean {
  let equal: boolean;
  if (typeof left === "number" && typeof right === "number") {
    equal = left === right;
  } else if (typeof left === "string" && typeof right === "string") {
    equal = stringEq(left, right);
  } else {
    fail(
      "TYPE_MISMATCH",
      `${operator} compares two numbers or two strings, got ${typeof left} and ${typeof right}`,
    );
  }
  return operator === "<>" || operator === "!=" ? !equal : equal;
}

function evalArithmetic(operator: string, left: number, right: number): number {
  let result: number;
  switch (operator) {
    case "+":
      result = left + right;
      break;
    case "-":
      result = left - right;
      break;
    case "*":
      result = left * right;
      break;
    case "/":
      if (right === 0) fail("TYPE_MISMATCH", "Division by zero");
      result = left / right;
      break;
    case "%":
      if (right === 0) fail("TYPE_MISMATCH", "Modulo by zero");
      result = left % right;
      break;
    default:
      fail("FORBIDDEN_NODE", `Binary operator "${operator}" is not allowed`);
  }
  if (!Number.isFinite(result)) {
    fail("TYPE_MISMATCH", `Arithmetic ${operator} produced a non-finite result`);
  }
  return result;
}

function evalCall(node: NodeShape, ctx: ExprContext, depth: number, state: EvalState): Value {
  const callee = asNode(node["callee"]);
  if (callee.type !== "Identifier") {
    fail("FORBIDDEN_NODE", "Function calls must use a bare function name (no member access)");
  }
  const rawName = callee["name"];
  if (typeof rawName !== "string") {
    fail("FORBIDDEN_NODE", "Malformed Identifier node (name is not a string)");
  }
  const fn = resolveFunctionName(rawName);
  if (fn === null) {
    fail("UNKNOWN_FUNCTION", `Unknown function "${rawName}"`);
  }
  const args = node["arguments"];
  if (!Array.isArray(args)) {
    fail("FORBIDDEN_NODE", "Malformed CallExpression (arguments is not an array)");
  }

  const num = (i: number): number =>
    requireNumber(evalNode(args[i], ctx, depth + 1, state), `${fn} argument ${i + 1}`);

  switch (fn) {
    case "CEIL":
    case "FLOOR":
    case "ROUND": {
      if (args.length !== 1) fail("TYPE_MISMATCH", `${fn} expects exactly 1 argument, got ${args.length}`);
      const x = num(0);
      // ROUND is half-up (away from zero) — the platform's commercial rounding.
      return fn === "CEIL" ? Math.ceil(x) : fn === "FLOOR" ? Math.floor(x) : roundHalfUp(x);
    }
    case "MIN":
    case "MAX": {
      if (args.length < 2) fail("TYPE_MISMATCH", `${fn} expects at least 2 arguments, got ${args.length}`);
      const values = args.map((_, i) => num(i));
      return fn === "MIN" ? Math.min(...values) : Math.max(...values);
    }
    case "IF": {
      if (args.length !== 3) {
        fail("TYPE_MISMATCH", `IF expects exactly 3 arguments (condition, then, else), got ${args.length}`);
      }
      const test = requireBoolean(evalNode(args[0], ctx, depth + 1, state), "IF condition");
      // Only the taken branch is evaluated.
      return evalNode(test ? args[1] : args[2], ctx, depth + 1, state);
    }
    case "CLAMP": {
      if (args.length !== 3) {
        fail("TYPE_MISMATCH", `CLAMP expects exactly 3 arguments (value, lo, hi), got ${args.length}`);
      }
      const [x, lo, hi] = [num(0), num(1), num(2)];
      if (lo > hi) fail("TYPE_MISMATCH", `CLAMP lower bound ${lo} exceeds upper bound ${hi}`);
      return Math.min(Math.max(x, lo), hi);
    }
  }
}

function evalNode(raw: unknown, ctx: ExprContext, depth: number, state: EvalState): Value {
  state.visited += 1;
  if (state.visited > MAX_NODES) {
    fail("TOO_COMPLEX", `Expression evaluation exceeded ${MAX_NODES} nodes`);
  }
  if (depth > MAX_DEPTH) {
    fail("TOO_COMPLEX", `Expression evaluation exceeded depth ${MAX_DEPTH}`);
  }
  const node = asNode(raw);

  switch (node.type) {
    case "Literal": {
      const value = node["value"];
      if (typeof value === "number") {
        if (!Number.isFinite(value)) fail("TYPE_MISMATCH", "Non-finite numeric literal");
        return value;
      }
      if (typeof value === "string" || typeof value === "boolean") return value;
      fail("TYPE_MISMATCH", `Unsupported literal ${String(value)}`);
      break;
    }

    case "Identifier":
      return resolveIdentifier(node["name"], ctx);

    case "UnaryExpression": {
      const operator = node["operator"];
      if (typeof operator !== "string") fail("FORBIDDEN_NODE", "Malformed UnaryExpression");
      if (NOT_OPS.has(operator)) {
        return !requireBoolean(evalNode(node["argument"], ctx, depth + 1, state), operator);
      }
      if (operator === "-") {
        return -requireNumber(evalNode(node["argument"], ctx, depth + 1, state), "Unary -");
      }
      fail("FORBIDDEN_NODE", `Unary operator "${operator}" is not allowed`);
      break;
    }

    case "BinaryExpression": {
      const operator = node["operator"];
      if (typeof operator !== "string") fail("FORBIDDEN_NODE", "Malformed BinaryExpression");

      if (LOGICAL_OPS.has(operator)) {
        const left = requireBoolean(evalNode(node["left"], ctx, depth + 1, state), operator);
        // Short-circuit: the right side is not evaluated when the left decides.
        if (operator === "AND" && !left) return false;
        if (operator === "OR" && left) return true;
        return requireBoolean(evalNode(node["right"], ctx, depth + 1, state), operator);
      }

      const left = evalNode(node["left"], ctx, depth + 1, state);
      const right = evalNode(node["right"], ctx, depth + 1, state);

      if (EQUALITY_OPS.has(operator)) return evalEquality(operator, left, right);

      if (RELATIONAL_OPS.has(operator)) {
        const l = requireNumber(left, `${operator} left side`);
        const r = requireNumber(right, `${operator} right side`);
        switch (operator) {
          case "<":
            return l < r;
          case "<=":
            return l <= r;
          case ">":
            return l > r;
          default:
            return l >= r;
        }
      }

      if (ARITHMETIC_OPS.has(operator)) {
        return evalArithmetic(
          operator,
          requireNumber(left, `${operator} left side`),
          requireNumber(right, `${operator} right side`),
        );
      }
      fail("FORBIDDEN_NODE", `Binary operator "${operator}" is not allowed`);
      break;
    }

    case "ConditionalExpression": {
      const test = requireBoolean(evalNode(node["test"], ctx, depth + 1, state), "Ternary condition");
      return evalNode(test ? node["consequent"] : node["alternate"], ctx, depth + 1, state);
    }

    case "CallExpression":
      return evalCall(node, ctx, depth, state);

    default:
      fail("FORBIDDEN_NODE", `${node.type} is not allowed in rule expressions`);
  }
}

/**
 * Evaluate a validated (jsep-shaped) AST against a rule context.
 * Throws ExprError on any structural, name, type, or arithmetic problem.
 */
export function evaluateAst(ast: unknown, ctx: ExprContext): number | boolean | string {
  if (typeof ctx !== "object" || ctx === null) {
    throw new ExprError("Evaluation context must be an object", [
      { code: "TYPE_MISMATCH", message: "Evaluation context must be an object" },
    ]);
  }
  return evalNode(ast, ctx, 1, { visited: 0 });
}
