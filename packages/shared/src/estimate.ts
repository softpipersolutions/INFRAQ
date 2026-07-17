import { z } from "zod";
import {
  INSTALL_RATE_UNITS,
  LINE_SOURCES,
  MARGIN_STATUSES,
  SITC_STATUSES,
  SYSTEM_TYPES,
  UNITS_OF_MEASURE,
  DISCOUNT_AUTHORITIES,
} from "./enums";

/**
 * Engine I/O types (spec B.01–B.03). All money is integer paise.
 * These shapes are shared by engines (produce), db (persist), documents
 * (render) and web (display) so the draft grid, the PDF, and the stored
 * version can never disagree structurally.
 */

/** B.01 output — one BOM line before pricing. */
export const bomLineSchema = z.object({
  systemType: z.enum(SYSTEM_TYPES),
  materialCode: z.string(),
  materialName: z.string(),
  unit: z.enum(UNITS_OF_MEASURE),
  qty: z.number().nonnegative(),
  ruleCode: z.string(),
  ruleId: z.string(),
  standardReference: z.string().nullable(),
});
export type BomLine = z.infer<typeof bomLineSchema>;

/** B.02 output — one fully priced estimate line. */
export const pricedLineSchema = z.object({
  lineUid: z.string(), // stable UUID carried across versions — powers diff
  systemType: z.enum(SYSTEM_TYPES),
  sectionOrder: z.number().int().nonnegative(),
  lineOrder: z.number().int().nonnegative(),
  materialCode: z.string(),
  /** Snapshot at generation/edit time — masters may change later. */
  description: z.string(),
  makeCode: z.string().nullable(),
  brandName: z.string().nullable(),
  qty: z.number().nonnegative(),
  unit: z.enum(UNITS_OF_MEASURE),
  supplyRatePaise: z.number().int().nonnegative(),
  installRatePaise: z.number().int().nonnegative(),
  sitcRatePaise: z.number().int().nonnegative(),
  supplyAmountPaise: z.number().int().nonnegative(),
  installAmountPaise: z.number().int().nonnegative(),
  lineAmountPaise: z.number().int().nonnegative(),
  source: z.enum(LINE_SOURCES),
  ruleCode: z.string().nullable(),
  priceId: z.string().nullable(),
  installRateCode: z.string().nullable(),
  installRateUnit: z.enum(INSTALL_RATE_UNITS).nullable(),
  note: z.string().nullable(),
  editReason: z.string().nullable(),
});
export type PricedLine = z.infer<typeof pricedLineSchema>;

/** B.03 output — SITC blended-ratio validation. */
export const sitcResultSchema = z.object({
  totalSupplyPaise: z.number().int(),
  totalInstallPaise: z.number().int(),
  totalSitcPaise: z.number().int(),
  /** total_SITC / total_supply, null when supply total is zero. */
  blendedRatio: z.number().nullable(),
  status: z.enum(SITC_STATUSES),
});
export type SitcResult = z.infer<typeof sitcResultSchema>;

/** Margin gate result. */
export const marginResultSchema = z.object({
  marginPct: z.number().nullable(),
  status: z.enum(MARGIN_STATUSES),
  /** Who must approve when below floor; null when OK. */
  requiredAuthority: z.enum(DISCOUNT_AUTHORITIES).nullable(),
});
export type MarginResult = z.infer<typeof marginResultSchema>;

export const estimateTotalsSchema = z.object({
  totalSupplyPaise: z.number().int(),
  totalInstallPaise: z.number().int(),
  totalSitcPaise: z.number().int(),
  gstPaise: z.number().int(),
  grandTotalPaise: z.number().int(),
  blendedRatio: z.number().nullable(),
});
export type EstimateTotals = z.infer<typeof estimateTotalsSchema>;

/** A rule that fired during generation (audit RULE_APPLIED payload). */
export const appliedRuleSchema = z.object({
  ruleId: z.string(),
  ruleCode: z.string(),
  ruleVersion: z.number().int(),
  conditionExpr: z.string(),
  quantityFormula: z.string(),
  quantityResult: z.number(),
  outputMaterialCode: z.string(),
  standardReference: z.string().nullable(),
});
export type AppliedRule = z.infer<typeof appliedRuleSchema>;

/** Non-fatal problems surfaced on the draft (rule failed, price missing…). */
export const generationWarningSchema = z.object({
  kind: z.enum([
    "RULE_EVAL_ERROR",
    "NO_RULES_MATCHED",
    "PRICE_MISSING",
    "INSTALL_RATE_MISSING",
    "MAKE_UNAVAILABLE",
    "MATERIAL_INACTIVE",
  ]),
  message: z.string(),
  ruleCode: z.string().nullable().optional().default(null),
  materialCode: z.string().nullable().optional().default(null),
  systemType: z.enum(SYSTEM_TYPES).nullable().optional().default(null),
});
export type GenerationWarning = z.infer<typeof generationWarningSchema>;

/** Full result of one deterministic generation run (draft v1). */
export const generationResultSchema = z.object({
  lines: z.array(pricedLineSchema),
  appliedRules: z.array(appliedRuleSchema),
  warnings: z.array(generationWarningSchema),
  sitc: sitcResultSchema,
  margin: marginResultSchema,
  totals: estimateTotalsSchema,
  /** Pinned inputs for exact replay: rule ids/versions + price ids used. */
  snapshot: z.object({
    ruleIds: z.array(z.string()),
    priceIds: z.array(z.string()),
    installRateCodes: z.array(z.string()),
    marginTier: z.number().int(),
    engineVersion: z.string(),
  }),
});
export type GenerationResult = z.infer<typeof generationResultSchema>;
