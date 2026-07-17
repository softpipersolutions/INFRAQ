import jsep from "jsep";

/**
 * jsep grammar configuration for the Pebble rule-expression language (spec
 * A.06). The surface is deliberately tiny:
 *
 *   logical:     OR (prec 1), AND (prec 2), unary NOT / !
 *   comparison:  = == <> !=   (prec 6)   < <= > >= (prec 7)
 *   arithmetic:  + -  (prec 9)   * / %   (prec 10), unary -
 *   ternary:     cond ? a : b   (jsep core ships the ternary hook)
 *   calls:       CEIL(x), MIN(a,b), IF(c,a,b), ...
 *
 * Everything else JavaScript-ish (&& || ?? bitwise shifts ** ~ unary + and
 * the null literal) is REMOVED so it becomes a parse error rather than a
 * silently accepted foreign operator. No jsep plugins are registered.
 */

/** Max AST nodes an expression may contain. */
export const MAX_NODES = 200;
/** Max AST depth (root = depth 1). */
export const MAX_DEPTH = 32;

/** Binary operators with equality semantics (numbers or strings). */
export const EQUALITY_OPS: ReadonlySet<string> = new Set(["=", "==", "<>", "!="]);
/** Binary operators with numeric-ordering semantics. */
export const RELATIONAL_OPS: ReadonlySet<string> = new Set(["<", "<=", ">", ">="]);
/** Boolean connectives (no truthiness coercion). */
export const LOGICAL_OPS: ReadonlySet<string> = new Set(["AND", "OR"]);
/** Numeric arithmetic operators. */
export const ARITHMETIC_OPS: ReadonlySet<string> = new Set(["+", "-", "*", "/", "%"]);
/** Unary operators producing booleans. */
export const NOT_OPS: ReadonlySet<string> = new Set(["NOT", "!"]);

let configured = false;

/** Apply the grammar exactly once (jsep is a module-level singleton). */
function configureJsep(): void {
  if (configured) return;
  configured = true;

  // Spec operators.
  jsep.addBinaryOp("OR", 1);
  jsep.addBinaryOp("AND", 2);
  jsep.addBinaryOp("=", 6); // alias of ==
  jsep.addBinaryOp("<>", 6); // alias of !=
  jsep.addUnaryOp("NOT"); // alias of !

  // Strip JavaScript operators outside the spec surface.
  for (const op of ["||", "??", "&&", "|", "^", "&", "===", "!==", "<<", ">>", ">>>", "**"]) {
    jsep.removeBinaryOp(op);
  }
  jsep.removeUnaryOp("~");
  jsep.removeUnaryOp("+");
  // `true`/`false` stay; `null` has no place in the type system.
  jsep.removeLiteral("null");
}

/**
 * Parse source text with the configured grammar. Throws (jsep's Error, or a
 * RangeError on pathological nesting) — callers wrap this into PARSE_ERROR.
 */
export function parseRaw(src: string): jsep.Expression {
  configureJsep();
  return jsep(src);
}
