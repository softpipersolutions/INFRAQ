import type { ExprContext, ExprKind } from "@pebble/shared";
import { ExprError } from "./errors";
import { evaluateAst } from "./evaluate";
import { validateExpression } from "./validate";

/**
 * @pebble/expr — the safe expression engine for user-authored design rules
 * (spec A.06).
 *
 * Rule authors write, in the spec's syntax:
 *   condition:        building_type = Commercial AND floor_area_sqm <= 500
 *   quantity formula: CEIL(total_area_sqm / 60)
 *
 * The engine parses with a locked-down jsep grammar, statically validates
 * (whitelisted nodes/operators, known identifiers, function arities, a full
 * static type check, complexity limits) and interprets the AST with strict
 * runtime typing — no eval, no Function, no prototype access, ever.
 */

export { ExprError } from "./errors";
export { evaluateAst } from "./evaluate";
export { validateExpression } from "./validate";

/**
 * Parse and fully validate `src` as a rule expression of the given kind.
 *
 * @returns The validated, serializable (jsep-shaped) AST — safe to persist
 *   in design_rules.*_ast and replay later with {@link evaluateAst}.
 * @throws ExprError carrying every validation issue when the source is
 *   invalid.
 */
export function parseExpression(src: string, kind: ExprKind): unknown {
  const result = validateExpression(src, kind);
  if (!result.ok || result.ast === null) {
    const summary = result.issues.map((i) => i.message).join("; ");
    throw new ExprError(`Invalid ${kind} expression: ${summary}`, result.issues);
  }
  return result.ast;
}

/**
 * Parse, validate and evaluate a condition expression.
 *
 * @returns The boolean the condition yields for `ctx`.
 * @throws ExprError when the source is invalid or does not yield a boolean.
 */
export function evaluateCondition(src: string, ctx: ExprContext): boolean {
  const ast = parseExpression(src, "condition");
  const value = evaluateAst(ast, ctx);
  if (typeof value !== "boolean") {
    const message = `Condition evaluated to ${typeof value}, expected boolean`;
    throw new ExprError(message, [{ code: "TYPE_MISMATCH", message }]);
  }
  return value;
}

/**
 * Parse, validate and evaluate a quantity formula.
 *
 * @returns The finite, non-negative number the formula yields for `ctx`.
 * @throws ExprError when the source is invalid, or the result is not a
 *   finite number >= 0.
 */
export function evaluateQuantity(src: string, ctx: ExprContext): number {
  const ast = parseExpression(src, "quantity");
  const value = evaluateAst(ast, ctx);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    const message = `Quantity formula evaluated to ${typeof value === "number" ? value : typeof value}, expected a finite number`;
    throw new ExprError(message, [{ code: "TYPE_MISMATCH", message }]);
  }
  if (value < 0) {
    const message = `Quantity formula evaluated to ${value}, quantities must be >= 0`;
    throw new ExprError(message, [{ code: "TYPE_MISMATCH", message }]);
  }
  return value;
}
