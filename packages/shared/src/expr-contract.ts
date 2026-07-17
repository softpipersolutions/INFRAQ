/**
 * Contract for the safe expression engine (packages/expr implements this).
 * Rule authors write spec-syntax expressions:
 *   condition:        building_type = Commercial AND floor_area_sqm <= 500
 *   quantity_formula: CEIL(total_area_sqm / 60)
 */

/** The ONLY identifiers rule expressions may reference. */
export interface ExprContext {
  building_type: string;
  floors_above: number;
  floor_area_sqm: number;
  /** floors_above (min 1 effective floor) × floor_area_sqm — precomputed. */
  total_area_sqm: number;
  /** The system type currently being generated (FAS, Hydrant…). */
  system: string;
  make_preference: string;
  applicable_standard: string;
  project_tier: number;
}

export const EXPR_IDENTIFIERS = [
  "building_type",
  "floors_above",
  "floor_area_sqm",
  "total_area_sqm",
  "system",
  "make_preference",
  "applicable_standard",
  "project_tier",
] as const;
export type ExprIdentifier = (typeof EXPR_IDENTIFIERS)[number];

export const EXPR_FUNCTIONS = [
  "CEIL",
  "FLOOR",
  "ROUND",
  "MIN",
  "MAX",
  "IF",
  "CLAMP",
] as const;
export type ExprFunction = (typeof EXPR_FUNCTIONS)[number];

export type ExprKind = "condition" | "quantity";

export interface ExprValidationIssue {
  code:
    | "PARSE_ERROR"
    | "UNKNOWN_IDENTIFIER"
    | "UNKNOWN_FUNCTION"
    | "FORBIDDEN_NODE"
    | "TYPE_MISMATCH"
    | "TOO_COMPLEX";
  message: string;
}

export interface ExprValidationResult {
  ok: boolean;
  issues: ExprValidationIssue[];
  /** Serializable validated AST (jsep shape) — stored in design_rules.*_ast. */
  ast: unknown | null;
}
