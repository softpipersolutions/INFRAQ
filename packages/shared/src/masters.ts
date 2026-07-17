import { z } from "zod";
import {
  APPLICABLE_STANDARDS,
  APPROVAL_STATUSES,
  DISCOUNT_AUTHORITIES,
  INSTALL_RATE_UNITS,
  MAKE_TIERS,
  MATERIAL_CATEGORIES,
  SYSTEM_TYPES,
  UNITS_OF_MEASURE,
} from "./enums";

/**
 * Master-data domain schemas (spec A.01–A.07).
 * These are the ENGINE-FACING shapes: monetary rates are integer paise,
 * date ranges are pre-resolved ("current rate as of generation"). The db
 * package maps table rows (NUMERIC strings, tstzrange) into these.
 */

/** A.01 Master Material Register */
export const materialSchema = z.object({
  materialCode: z.string().min(1), // e.g. FAS-SMK-001
  materialName: z.string().min(1),
  systemType: z.enum(SYSTEM_TYPES),
  category: z.enum(MATERIAL_CATEGORIES),
  unitOfMeasure: z.enum(UNITS_OF_MEASURE),
  active: z.boolean(),
});
export type Material = z.infer<typeof materialSchema>;

/** A.02 Master Spec Data (1:1 with material) */
export const materialSpecSchema = z.object({
  materialCode: z.string().min(1),
  applicableStandard: z.enum(APPLICABLE_STANDARDS).nullable(),
  rating: z.string().nullable(),
  size: z.string().nullable(),
  certifications: z.array(z.string()),
  complianceNotes: z.string().nullable(),
});
export type MaterialSpec = z.infer<typeof materialSpecSchema>;

/** A.03 Makes & Brand Database */
export const makeSchema = z.object({
  makeCode: z.string().min(1), // e.g. HON-FAS
  materialCode: z.string().min(1),
  brandName: z.string().min(1),
  tier: z.enum(MAKE_TIERS),
  approvalStatus: z.enum(APPROVAL_STATUSES),
  notes: z.string().nullable(),
});
export type Make = z.infer<typeof makeSchema>;

/** A.04 Pricing Database — one resolved (currently effective) rate row. */
export const priceSchema = z.object({
  priceId: z.string().min(1), // ULID
  materialCode: z.string().min(1),
  makeCode: z.string().min(1),
  buyingRatePaise: z.number().int().nonnegative(),
  sellingRatePaise: z.number().int().nonnegative(),
  effectiveFrom: z.string(), // ISO timestamp — provenance for audit payloads
});
export type Price = z.infer<typeof priceSchema>;

/** A.05 Installation Rates Master — resolved effective row. */
export const installRateSchema = z.object({
  rateCode: z.string().min(1), // e.g. INST-DET-001
  description: z.string().min(1),
  systemType: z.enum(SYSTEM_TYPES),
  linkedMaterialCode: z.string().nullable(),
  ratePaise: z.number().int().nonnegative(),
  unit: z.enum(INSTALL_RATE_UNITS),
  effectiveFrom: z.string(),
});
export type InstallRate = z.infer<typeof installRateSchema>;

/** A.06 Design Logic Rules — one versioned rule. */
export const designRuleSchema = z.object({
  ruleId: z.string().min(1), // ULID of this rule version row
  ruleCode: z.string().min(1), // e.g. DL-FAS-001
  ruleVersion: z.number().int().positive(),
  systemType: z.enum(SYSTEM_TYPES),
  conditionExpr: z.string().min(1), // e.g. building_type = Commercial AND floor_area_sqm <= 500
  quantityFormula: z.string().min(1), // e.g. CEIL(total_area_sqm / 60)
  outputMaterialCode: z.string().min(1),
  standardReference: z.string().nullable(), // e.g. "IS 2189 cl. 6.2 spacing table"
  active: z.boolean(),
});
export type DesignRule = z.infer<typeof designRuleSchema>;

/** A.07 Profit Margin Matrix — one tier row. */
export const marginRowSchema = z.object({
  tier: z.number().int().min(1).max(4),
  tierLabel: z.string(),
  targetMarginPct: z.number().min(0).max(100),
  floorMarginPct: z.number().min(0).max(100),
  discountAuthority: z.enum(DISCOUNT_AUTHORITIES),
});
export type MarginRow = z.infer<typeof marginRowSchema>;

/** Everything the generation engines need, resolved as of one instant. */
export const masterSnapshotSchema = z.object({
  materials: z.array(materialSchema),
  specs: z.array(materialSpecSchema),
  makes: z.array(makeSchema),
  prices: z.array(priceSchema),
  installRates: z.array(installRateSchema),
  rules: z.array(designRuleSchema),
  marginMatrix: z.array(marginRowSchema),
});
export type MasterSnapshot = z.infer<typeof masterSnapshotSchema>;
