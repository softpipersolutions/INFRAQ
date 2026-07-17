import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import {
  applicableStandardEnum,
  approvalStatusEnum,
  discountAuthorityEnum,
  installRateUnitEnum,
  makeTierEnum,
  materialCategoryEnum,
  systemTypeEnum,
  unitOfMeasureEnum,
} from "./enums";

/**
 * Master data tables (spec A.01–A.07) plus the id-sequence table.
 * Monetary NUMERIC(14,2) columns store rupees; all in-process arithmetic
 * happens in integer paise (see @pebble/shared money utils).
 */

/** A.01 Master Material Register. */
export const materials = pgTable("materials", {
  materialCode: text("material_code").primaryKey(),
  materialName: text("material_name").notNull(),
  systemType: systemTypeEnum("system_type").notNull(),
  category: materialCategoryEnum("category").notNull(),
  unitOfMeasure: unitOfMeasureEnum("unit_of_measure").notNull(),
  active: boolean("active").notNull().default(true),
  /** Ingestion provenance (source document / staged record refs); null for hand-entered rows. */
  sourceProvenance: jsonb("source_provenance").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A.02 Master Spec Data — 1:1 with materials. */
export const materialSpecs = pgTable("material_specs", {
  materialCode: text("material_code")
    .primaryKey()
    .references(() => materials.materialCode),
  applicableStandard: applicableStandardEnum("applicable_standard"),
  rating: text("rating"),
  size: text("size"),
  certifications: text("certifications")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  complianceNotes: text("compliance_notes"),
});

/** A.03 Makes & Brand Database — one row per (brand, material) combination. */
export const makes = pgTable("makes", {
  makeCode: text("make_code").primaryKey(),
  materialCode: text("material_code")
    .notNull()
    .references(() => materials.materialCode),
  brandName: text("brand_name").notNull(),
  tier: makeTierEnum("tier").notNull(),
  approvalStatus: approvalStatusEnum("approval_status").notNull(),
  notes: text("notes"),
});

/**
 * A.04 Pricing Database — temporal rows. The currently effective rate has
 * valid_to IS NULL; the migration adds a gist EXCLUDE constraint so ranges
 * for one (material_code, make_code) can never overlap.
 */
export const prices = pgTable("prices", {
  priceId: text("price_id").primaryKey(), // ULID
  materialCode: text("material_code")
    .notNull()
    .references(() => materials.materialCode),
  makeCode: text("make_code")
    .notNull()
    .references(() => makes.makeCode),
  buyingRate: numeric("buying_rate", { precision: 14, scale: 2 }).notNull(),
  sellingRate: numeric("selling_rate", { precision: 14, scale: 2 }).notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
  /** NULL = open-ended (current) rate. */
  validTo: timestamp("valid_to", { withTimezone: true }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A.05 Installation Rates Master — temporal rows keyed by rate_code with the
 * same open-range convention (and EXCLUDE constraint) as prices.
 */
export const installRates = pgTable("install_rates", {
  id: text("id").primaryKey(), // ULID
  rateCode: text("rate_code").notNull(),
  description: text("description").notNull(),
  systemType: systemTypeEnum("system_type").notNull(),
  linkedMaterialCode: text("linked_material").references(() => materials.materialCode),
  rate: numeric("rate", { precision: 14, scale: 2 }).notNull(),
  unit: installRateUnitEnum("unit").notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
  validTo: timestamp("valid_to", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A.06 Design Logic Rules — append-only versions per rule_code; exactly one
 * version of a rule_code should be active at a time (managed by upsertRule).
 */
export const designRules = pgTable(
  "design_rules",
  {
    ruleId: text("rule_id").primaryKey(), // ULID of this rule VERSION
    ruleCode: text("rule_code").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    systemType: systemTypeEnum("system_type").notNull(),
    conditionExpr: text("condition_expr").notNull(),
    conditionAst: jsonb("condition_ast"),
    quantityFormula: text("quantity_formula").notNull(),
    quantityAst: jsonb("quantity_ast"),
    outputMaterialCode: text("output_material_code")
      .notNull()
      .references(() => materials.materialCode),
    standardReference: text("standard_reference"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("design_rules_code_version_uq").on(t.ruleCode, t.ruleVersion)],
);

/** A.07 Profit Margin Matrix — exactly four tier rows. */
export const marginMatrix = pgTable("margin_matrix", {
  tier: integer("tier").primaryKey(),
  tierLabel: text("tier_label").notNull(),
  targetMarginPct: numeric("target_margin_pct", { precision: 5, scale: 2 }).notNull(),
  floorMarginPct: numeric("floor_margin_pct", { precision: 5, scale: 2 }).notNull(),
  discountAuthority: discountAuthorityEnum("discount_authority").notNull(),
});

/**
 * Yearly business-id counters for GBE-ENQ-2025-001 style ids.
 * Incremented atomically via INSERT … ON CONFLICT DO UPDATE … RETURNING.
 */
export const sequences = pgTable(
  "sequences",
  {
    name: text("name").notNull(),
    year: integer("year").notNull(),
    value: integer("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.name, t.year] })],
);
