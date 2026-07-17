import { integer, jsonb, numeric, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import {
  applicableStandardEnum,
  buildingTypeEnum,
  discountAuthorityEnum,
  enquirySourceEnum,
  estimateStatusEnum,
  installRateUnitEnum,
  lineSourceEnum,
  makePreferenceEnum,
  marginStatusEnum,
  sitcStatusEnum,
  systemTypeEnum,
  unitOfMeasureEnum,
  versionStateEnum,
} from "./enums";

/**
 * Enquiry → estimate → version → line hierarchy.
 * Versions are immutable once LOCKED (enforced by triggers added in the
 * migration); WORKING versions are the only mutable surface.
 */

/** A.08 Enquiry — the standardized record that triggers generation. */
export const enquiries = pgTable("enquiries", {
  enquiryId: text("enquiry_id").primaryKey(), // GBE-ENQ-2025-001
  clientName: text("client_name").notNull(),
  projectName: text("project_name").notNull(),
  buildingType: buildingTypeEnum("building_type").notNull(),
  floorsAbove: integer("floors_above").notNull(),
  floorAreaSqm: numeric("floor_area_sqm", { precision: 12, scale: 2 }).notNull(),
  /** Canonical SystemType values (validated by zod before insert). */
  systemsRequired: text("systems_required").array().notNull(),
  makePreference: makePreferenceEnum("make_preference").notNull(),
  applicableStandard: applicableStandardEnum("applicable_standard").notNull(),
  projectTier: integer("project_tier").notNull(),
  clientEmail: text("client_email"),
  clientPhone: text("client_phone"),
  notes: text("notes"),
  source: enquirySourceEnum("source").notNull(),
  status: text("status").notNull().default("OPEN"),
  chatSessionId: text("chat_session_id"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One estimate per generation run; versions hang off it. */
export const estimates = pgTable("estimates", {
  estimateId: text("estimate_id").primaryKey(), // GBE-EST-2025-001
  enquiryId: text("enquiry_id")
    .notNull()
    .references(() => enquiries.enquiryId),
  status: estimateStatusEnum("status").notNull(),
  currentVersion: integer("current_version").notNull().default(1),
  sitcStatus: sitcStatusEnum("sitc_status"),
  marginStatus: marginStatusEnum("margin_status"),
  requiredAuthority: discountAuthorityEnum("required_authority"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One immutable-when-LOCKED snapshot of an estimate.
 * generation_snapshot pins rule ids/versions, price ids, install rate codes,
 * the engine version and any generation warnings for exact replay.
 */
export const estimateVersions = pgTable(
  "estimate_versions",
  {
    id: text("id").primaryKey(), // ULID
    estimateId: text("estimate_id")
      .notNull()
      .references(() => estimates.estimateId),
    versionNo: integer("version_no").notNull(),
    state: versionStateEnum("state").notNull(),
    basedOnVersion: integer("based_on_version"),
    generationSnapshot: jsonb("generation_snapshot").$type<Record<string, unknown>>(),
    totalSupply: numeric("total_supply", { precision: 14, scale: 2 }).notNull(),
    totalInstall: numeric("total_install", { precision: 14, scale: 2 }).notNull(),
    totalSitc: numeric("total_sitc", { precision: 14, scale: 2 }).notNull(),
    blendedRatio: numeric("blended_ratio", { precision: 8, scale: 4 }),
    marginPct: numeric("margin_pct", { precision: 6, scale: 2 }),
    gstAmount: numeric("gst_amount", { precision: 14, scale: 2 }).notNull(),
    grandTotal: numeric("grand_total", { precision: 14, scale: 2 }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
  },
  (t) => [unique("estimate_versions_estimate_version_uq").on(t.estimateId, t.versionNo)],
);

/**
 * Estimate lines. line_uid is stable across versions (powers diffing);
 * id is unique per row. Rates/amounts are snapshots taken at generation or
 * edit time — masters may change afterwards without affecting them.
 */
export const estimateLines = pgTable("estimate_lines", {
  id: text("id").primaryKey(), // ULID
  estimateVersionId: text("estimate_version_id")
    .notNull()
    .references(() => estimateVersions.id, { onDelete: "cascade" }),
  lineUid: text("line_uid").notNull(),
  systemType: systemTypeEnum("system_type").notNull(),
  sectionOrder: integer("section_order").notNull(),
  lineOrder: integer("line_order").notNull(),
  materialCode: text("material_code").notNull(),
  description: text("description").notNull(),
  makeCode: text("make_code"),
  brandName: text("brand_name"),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull(),
  unit: unitOfMeasureEnum("unit").notNull(),
  supplyRate: numeric("supply_rate", { precision: 14, scale: 2 }).notNull(),
  installRate: numeric("install_rate", { precision: 14, scale: 2 }).notNull(),
  sitcRate: numeric("sitc_rate", { precision: 14, scale: 2 }).notNull(),
  supplyAmount: numeric("supply_amount", { precision: 14, scale: 2 }).notNull(),
  installAmount: numeric("install_amount", { precision: 14, scale: 2 }).notNull(),
  lineAmount: numeric("line_amount", { precision: 14, scale: 2 }).notNull(),
  source: lineSourceEnum("source").notNull(),
  ruleCode: text("rule_code"),
  priceId: text("price_id"),
  installRateCode: text("install_rate_code"),
  installRateUnit: installRateUnitEnum("install_rate_unit"),
  note: text("note"),
  editReason: text("edit_reason"),
});
