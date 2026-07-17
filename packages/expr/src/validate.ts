import type {
  ExprKind,
  ExprValidationIssue,
  ExprValidationResult,
} from "@pebble/shared";
import type jsep from "jsep";
import {
  ARITHMETIC_OPS,
  EQUALITY_OPS,
  LOGICAL_OPS,
  MAX_DEPTH,
  MAX_NODES,
  NOT_OPS,
  RELATIONAL_OPS,
  parseRaw,
} from "./grammar";
import {
  IDENTIFIER_TYPES,
  isContextIdentifier,
  resolveEnumWord,
  resolveFunctionName,
} from "./resolve";
import type { StaticType } from "./resolve";

/**
 * Static validation: parse, enforce the node/operator whitelist and
 * complexity limits, resolve every name, and infer a static type for every
 * node so the root can be checked against the expression kind
 * ('condition' → boolean, 'quantity' → number).
 */

interface WalkState {
  issues: ExprValidationIssue[];
  nodeCount: number;
  /** Set once when a depth or node-count limit is crossed. */
  tooComplex: boolean;
}

function issue(state: WalkState, code: ExprValidationIssue["code"], message: string): void {
  state.issues.push({ code, message });
}

/** Human label for an operand type in messages. */
function label(t: StaticType): string {
  return t === "unknown" ? "unknown" : t;
}

/**
 * Infer the static type of `node`, recording issues along the way.
 * Returns "unknown" when the type cannot be established (an issue has
 * already been recorded in that case), which suppresses cascading errors.
 */
function infer(node: jsep.Expression, depth: number, state: WalkState): StaticType {
  state.nodeCount += 1;
  if (state.nodeCount > MAX_NODES) {
    state.tooComplex = true;
    return "unknown";
  }
  if (depth > MAX_DEPTH) {
    // Do not recurse further — keeps the walk stack bounded even for
    // adversarial 100k-term expressions.
    state.tooComplex = true;
    return "unknown";
  }
  if (state.tooComplex) return "unknown";

  switch (node.type) {
    case "Literal": {
      const value = (node as jsep.Literal).value;
      switch (typeof value) {
        case "number":
          return "number";
        case "string":
          return "string";
        case "boolean":
          return "boolean";
        default:
          issue(state, "TYPE_MISMATCH", `Unsupported literal ${String(value)}`);
          return "unknown";
      }
    }

    case "Identifier": {
      const name = (node as jsep.Identifier).name;
      if (isContextIdentifier(name)) return IDENTIFIER_TYPES[name];
      if (resolveEnumWord(name) !== null) return "string";
      issue(
        state,
        "UNKNOWN_IDENTIFIER",
        `Unknown identifier "${name}" — expected a context field, a known enum value, or a quoted string`,
      );
      return "unknown";
    }

    case "UnaryExpression": {
      const { operator, argument } = node as jsep.UnaryExpression;
      const argType = infer(argument, depth + 1, state);
      if (NOT_OPS.has(operator)) {
        if (argType !== "boolean" && argType !== "unknown") {
          issue(state, "TYPE_MISMATCH", `${operator} requires a boolean operand, got ${label(argType)}`);
        }
        return "boolean";
      }
      if (operator === "-") {
        if (argType !== "number" && argType !== "unknown") {
          issue(state, "TYPE_MISMATCH", `Unary - requires a number operand, got ${label(argType)}`);
        }
        return "number";
      }
      issue(state, "FORBIDDEN_NODE", `Unary operator "${operator}" is not allowed`);
      return "unknown";
    }

    case "BinaryExpression": {
      const { operator, left, right } = node as jsep.BinaryExpression;
      const leftType = infer(left, depth + 1, state);
      const rightType = infer(right, depth + 1, state);

      if (LOGICAL_OPS.has(operator)) {
        for (const [side, t] of [["left", leftType], ["right", rightType]] as const) {
          if (t !== "boolean" && t !== "unknown") {
            issue(state, "TYPE_MISMATCH", `${operator} requires boolean operands, ${side} side is ${label(t)}`);
          }
        }
        return "boolean";
      }
      if (EQUALITY_OPS.has(operator)) {
        if (leftType !== "unknown" && rightType !== "unknown") {
          if (leftType !== rightType) {
            issue(state, "TYPE_MISMATCH", `Cannot compare ${label(leftType)} with ${label(rightType)} using ${operator}`);
          } else if (leftType === "boolean") {
            issue(state, "TYPE_MISMATCH", `${operator} compares numbers or strings, not booleans`);
          }
        }
        return "boolean";
      }
      if (RELATIONAL_OPS.has(operator)) {
        for (const [side, t] of [["left", leftType], ["right", rightType]] as const) {
          if (t !== "number" && t !== "unknown") {
            issue(state, "TYPE_MISMATCH", `${operator} compares numbers only, ${side} side is ${label(t)}`);
          }
        }
        return "boolean";
      }
      if (ARITHMETIC_OPS.has(operator)) {
        for (const [side, t] of [["left", leftType], ["right", rightType]] as const) {
          if (t !== "number" && t !== "unknown") {
            issue(state, "TYPE_MISMATCH", `Arithmetic ${operator} requires numbers, ${side} side is ${label(t)}`);
          }
        }
        return "number";
      }
      issue(state, "FORBIDDEN_NODE", `Binary operator "${operator}" is not allowed`);
      return "unknown";
    }

    case "ConditionalExpression": {
      const { test, consequent, alternate } = node as jsep.ConditionalExpression;
      const testType = infer(test, depth + 1, state);
      if (testType !== "boolean" && testType !== "unknown") {
        issue(state, "TYPE_MISMATCH", `Ternary condition must be boolean, got ${label(testType)}`);
      }
      return branchType(infer(consequent, depth + 1, state), infer(alternate, depth + 1, state), "?:", state);
    }

    case "CallExpression": {
      const { callee, arguments: args } = node as jsep.CallExpression;
      if (callee.type !== "Identifier") {
        // e.g. Math.floor(1) — do not descend into the callee.
        issue(state, "FORBIDDEN_NODE", "Function calls must use a bare function name (no member access)");
        for (const arg of args) infer(arg, depth + 1, state);
        return "unknown";
      }
      const rawName = (callee as jsep.Identifier).name;
      const fn = resolveFunctionName(rawName);
      if (fn === null) {
        issue(state, "UNKNOWN_FUNCTION", `Unknown function "${rawName}" — allowed: CEIL, FLOOR, ROUND, MIN, MAX, IF, CLAMP`);
        for (const arg of args) infer(arg, depth + 1, state);
        return "unknown";
      }
      // Canonicalize the stored AST (ceil → CEIL).
      (callee as jsep.Identifier).name = fn;

      const argTypes = args.map((arg) => infer(arg, depth + 1, state));
      const arityOk = checkArity(fn, args.length, state);

      if (fn === "IF") {
        if (arityOk) {
          const [testType, thenType, elseType] = argTypes as [StaticType, StaticType, StaticType];
          if (testType !== "boolean" && testType !== "unknown") {
            issue(state, "TYPE_MISMATCH", `IF condition must be boolean, got ${label(testType)}`);
          }
          return branchType(thenType, elseType, "IF", state);
        }
        return "unknown";
      }
      // All remaining functions take numbers and return a number.
      argTypes.forEach((t, i) => {
        if (t !== "number" && t !== "unknown") {
          issue(state, "TYPE_MISMATCH", `${fn} argument ${i + 1} must be a number, got ${label(t)}`);
        }
      });
      return "number";
    }

    default:
      issue(state, "FORBIDDEN_NODE", `${node.type} is not allowed in rule expressions`);
      return "unknown";
  }
}

/** Common branch-type logic for ternary and IF. */
function branchType(thenType: StaticType, elseType: StaticType, what: string, state: WalkState): StaticType {
  if (thenType === "unknown" || elseType === "unknown") return "unknown";
  if (thenType !== elseType) {
    issue(state, "TYPE_MISMATCH", `${what} branches must have the same type (got ${label(thenType)} and ${label(elseType)})`);
    return "unknown";
  }
  return thenType;
}

/** Records a TYPE_MISMATCH issue when the call arity is wrong; true when OK. */
function checkArity(fn: string, count: number, state: WalkState): boolean {
  let ok = true;
  switch (fn) {
    case "CEIL":
    case "FLOOR":
    case "ROUND":
      ok = count === 1;
      if (!ok) issue(state, "TYPE_MISMATCH", `${fn} expects exactly 1 argument, got ${count}`);
      break;
    case "MIN":
    case "MAX":
      ok = count >= 2;
      if (!ok) issue(state, "TYPE_MISMATCH", `${fn} expects at least 2 arguments, got ${count}`);
      break;
    case "IF":
      ok = count === 3;
      if (!ok) issue(state, "TYPE_MISMATCH", `IF expects exactly 3 arguments (condition, then, else), got ${count}`);
      break;
    case "CLAMP":
      ok = count === 3;
      if (!ok) issue(state, "TYPE_MISMATCH", `CLAMP expects exactly 3 arguments (value, lo, hi), got ${count}`);
      break;
  }
  return ok;
}

/**
 * Validate `src` as a rule expression of the given kind. Never throws.
 *
 * ok is true iff there are zero issues; `ast` carries the validated,
 * serializable (jsep-shaped) AST only when ok — function names are
 * canonicalized (ceil → CEIL) so stored ASTs are stable.
 */
export function validateExpression(src: string, kind: ExprKind): ExprValidationResult {
  try {
    if (typeof src !== "string" || src.trim() === "") {
      return {
        ok: false,
        issues: [{ code: "PARSE_ERROR", message: "Expression is empty" }],
        ast: null,
      };
    }

    let ast: jsep.Expression;
    try {
      ast = parseRaw(src);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        issues: [{ code: "PARSE_ERROR", message: `Could not parse expression: ${detail}` }],
        ast: null,
      };
    }

    const state: WalkState = { issues: [], nodeCount: 0, tooComplex: false };
    const rootType = infer(ast, 1, state);

    if (state.tooComplex) {
      issue(
        state,
        "TOO_COMPLEX",
        `Expression is too complex (max ${MAX_NODES} nodes, max depth ${MAX_DEPTH})`,
      );
    } else if (kind === "condition" && rootType !== "boolean" && rootType !== "unknown") {
      issue(state, "TYPE_MISMATCH", `A condition must evaluate to a boolean, this expression yields a ${label(rootType)}`);
    } else if (kind === "quantity" && rootType !== "number" && rootType !== "unknown") {
      issue(state, "TYPE_MISMATCH", `A quantity formula must evaluate to a number, this expression yields a ${label(rootType)}`);
    }

    const ok = state.issues.length === 0;
    return { ok, issues: state.issues, ast: ok ? ast : null };
  } catch (err) {
    // validateExpression must never throw — degrade to a diagnostic issue.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      issues: [{ code: "PARSE_ERROR", message: `Validation failed unexpectedly: ${detail}` }],
      ast: null,
    };
  }
}
