/**
 * `@pebble/documents` — Format A document generators.
 *
 * Format A is the professional Greenberg fire-safety BOQ/quotation. This package
 * turns one immutable `FormatAInput` into either:
 *  - a self-contained HTML document (`renderFormatAHtml`) used for the on-screen
 *    preview and as the source the worker rasterises to PDF, or
 *  - an Excel workbook (`buildFormatAWorkbook` / `formatAWorkbookBuffer`) with
 *    live subtotal/GST/grand-total formulas.
 *
 * Both are pure functions of the input; money is taken verbatim from the
 * engine's `EstimateTotals` and never recomputed here.
 */

// Renderers.
export { renderFormatAHtml, escapeHtml } from "./html";
export { buildFormatAWorkbook, formatAWorkbookBuffer } from "./excel";

// Input construction, defaults, and grouping helpers.
export {
  DEFAULT_COMPANY,
  DEFAULT_TERMS,
  buildFormatAInput,
  groupLinesIntoSections,
  lineDescription,
  toRoman,
} from "./types";

// Types.
export type {
  FormatAInput,
  FormatAMode,
  FormatASection,
  FormatAProjectSource,
  BuildFormatAInputArgs,
  CompanyConfig,
  BankDetails,
  EstimateMeta,
  ProjectMeta,
} from "./types";
