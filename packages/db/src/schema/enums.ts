import { pgEnum } from "drizzle-orm/pg-core";
import {
  APPLICABLE_STANDARDS,
  APPROVAL_STATUSES,
  AUDIT_EVENT_TYPES,
  BUILDING_TYPES,
  DISCOUNT_AUTHORITIES,
  DISPATCH_CHANNELS,
  DISPATCH_STATUSES,
  DOCUMENT_KINDS,
  ENQUIRY_SOURCES,
  ESTIMATE_STATUSES,
  INSTALL_RATE_UNITS,
  LINE_SOURCES,
  MAKE_PREFERENCES,
  MAKE_TIERS,
  MARGIN_STATUSES,
  MATERIAL_CATEGORIES,
  SITC_STATUSES,
  STAGED_RECORD_STATUSES,
  SYSTEM_TYPES,
  UNITS_OF_MEASURE,
  USER_ROLES,
  VERSION_STATES,
} from "@pebble/shared";

/**
 * Postgres enum types — every one derives from the frozen const arrays in
 * @pebble/shared so the database, zod schemas and UI can never disagree.
 * drizzle's pgEnum accepts the readonly tuples directly, preserving literal
 * union types on the columns.
 */

export const systemTypeEnum = pgEnum("system_type", SYSTEM_TYPES);
export const materialCategoryEnum = pgEnum("material_category", MATERIAL_CATEGORIES);
export const unitOfMeasureEnum = pgEnum("unit_of_measure", UNITS_OF_MEASURE);
export const applicableStandardEnum = pgEnum("applicable_standard", APPLICABLE_STANDARDS);
export const makeTierEnum = pgEnum("make_tier", MAKE_TIERS);
export const approvalStatusEnum = pgEnum("approval_status", APPROVAL_STATUSES);
export const buildingTypeEnum = pgEnum("building_type", BUILDING_TYPES);
export const makePreferenceEnum = pgEnum("make_preference", MAKE_PREFERENCES);
export const installRateUnitEnum = pgEnum("install_rate_unit", INSTALL_RATE_UNITS);
export const discountAuthorityEnum = pgEnum("discount_authority", DISCOUNT_AUTHORITIES);
export const estimateStatusEnum = pgEnum("estimate_status", ESTIMATE_STATUSES);
export const sitcStatusEnum = pgEnum("sitc_status", SITC_STATUSES);
export const marginStatusEnum = pgEnum("margin_status", MARGIN_STATUSES);
export const versionStateEnum = pgEnum("version_state", VERSION_STATES);
export const lineSourceEnum = pgEnum("line_source", LINE_SOURCES);
export const enquirySourceEnum = pgEnum("enquiry_source", ENQUIRY_SOURCES);
export const userRoleEnum = pgEnum("user_role", USER_ROLES);
export const auditEventTypeEnum = pgEnum("audit_event_type", AUDIT_EVENT_TYPES);
export const dispatchChannelEnum = pgEnum("dispatch_channel", DISPATCH_CHANNELS);
export const dispatchStatusEnum = pgEnum("dispatch_status", DISPATCH_STATUSES);
export const documentKindEnum = pgEnum("document_kind", DOCUMENT_KINDS);
export const stagedRecordStatusEnum = pgEnum("staged_record_status", STAGED_RECORD_STATUSES);
