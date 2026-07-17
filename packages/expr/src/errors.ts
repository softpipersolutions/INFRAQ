import type { ExprValidationIssue } from "@pebble/shared";

/**
 * Error thrown by the expression engine for any parse, validation, or
 * evaluation failure. Carries the structured issue list so callers (rule
 * editors, the generation engine's warning collector) can surface precise
 * diagnostics instead of string-matching messages.
 */
export class ExprError extends Error {
  /** Structured issues that caused this error (never empty). */
  readonly issues: ExprValidationIssue[];

  constructor(message: string, issues: ExprValidationIssue[]) {
    super(message);
    this.name = "ExprError";
    this.issues = issues;
  }
}

/** Build and throw an ExprError carrying a single issue. */
export function fail(code: ExprValidationIssue["code"], message: string): never {
  throw new ExprError(message, [{ code, message }]);
}
