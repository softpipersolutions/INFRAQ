/**
 * Canonical enums for Pebble Module 02 — mirrors spec sections A.01–A.08.
 * These arrays are the single source of truth: zod schemas, Drizzle pg enums,
 * and UI selects all derive from them.
 */

export const SYSTEM_TYPES = [
  "FAS",
  "Hydrant",
  "Sprinkler",
  "Extinguisher",
  "Suppression",
  "Common",
] as const;
export type SystemType = (typeof SYSTEM_TYPES)[number];

export const MATERIAL_CATEGORIES = [
  "Detector",
  "Panel",
  "Cable",
  "Pipe",
  "Valve",
  "Pump",
  "Fitting",
  "Extinguisher",
  "Accessory",
  "Signage",
] as const;
export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number];

/**
 * Spec A.01 lists six units; "Man-day" is added because labour line items in
 * the historical corpus (2022–2026 proposals) are quoted per man-day.
 */
export const UNITS_OF_MEASURE = [
  "No.",
  "Metre",
  "Set",
  "Kg",
  "Litre",
  "Lot",
  "Man-day",
] as const;
export type UnitOfMeasure = (typeof UNITS_OF_MEASURE)[number];

export const APPLICABLE_STANDARDS = [
  "IS",
  "NBC 2016",
  "NFPA",
  "UL Listed",
  "FM Approved",
  "Client Spec",
] as const;
export type ApplicableStandard = (typeof APPLICABLE_STANDARDS)[number];

export const MAKE_TIERS = ["Premium", "Standard", "Economy"] as const;
export type MakeTier = (typeof MAKE_TIERS)[number];

export const APPROVAL_STATUSES = ["Approved", "Conditional", "Blacklisted"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const BUILDING_TYPES = [
  "Residential",
  "Commercial",
  "Industrial",
  "Institutional",
  "Mixed",
] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];

export const MAKE_PREFERENCES = [
  "Premium",
  "Standard",
  "Economy",
  "As per Greenberg",
] as const;
export type MakePreference = (typeof MAKE_PREFERENCES)[number];

export const INSTALL_RATE_UNITS = [
  "Per No.",
  "Per Metre",
  "Per Set",
  "Per Floor",
  "Lumpsum",
] as const;
export type InstallRateUnit = (typeof INSTALL_RATE_UNITS)[number];

export const PROJECT_TIERS = [1, 2, 3, 4] as const;
export type ProjectTier = (typeof PROJECT_TIERS)[number];

export const DISCOUNT_AUTHORITIES = ["Self", "GM", "MD"] as const;
export type DiscountAuthority = (typeof DISCOUNT_AUTHORITIES)[number];

export const ESTIMATE_STATUSES = [
  "GENERATING",
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "DISPATCHED",
  "REVISED",
] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export const SITC_STATUSES = ["PASS", "ALERT"] as const;
export type SitcStatus = (typeof SITC_STATUSES)[number];

export const MARGIN_STATUSES = ["OK", "BELOW_FLOOR"] as const;
export type MarginStatus = (typeof MARGIN_STATUSES)[number];

export const VERSION_STATES = ["WORKING", "LOCKED"] as const;
export type VersionState = (typeof VERSION_STATES)[number];

export const LINE_SOURCES = ["RULE", "MANUAL"] as const;
export type LineSource = (typeof LINE_SOURCES)[number];

export const ENQUIRY_SOURCES = ["form", "chat"] as const;
export type EnquirySource = (typeof ENQUIRY_SOURCES)[number];

export const USER_ROLES = ["admin", "estimator", "approver"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Spec section D — the complete, closed set of audit event types. */
export const AUDIT_EVENT_TYPES = [
  "ENQ_CREATED",
  "GEN_STARTED",
  "RULE_APPLIED",
  "PRICE_APPLIED",
  "SITC_VALIDATED",
  "DRAFT_v1_CREATED",
  "REVIEW_STARTED",
  "LINE_EDITED",
  "LINE_ADDED",
  "LINE_REMOVED",
  "EST_APPROVED",
  "OUTPUT_GENERATED",
  "EST_DISPATCHED",
  "EST_REVISED",
  "STAGED_COMMITTED", // Phase B — a reviewed staged_record committed to a master.
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const DISPATCH_CHANNELS = ["EMAIL", "WHATSAPP"] as const;
export type DispatchChannel = (typeof DISPATCH_CHANNELS)[number];

export const DISPATCH_STATUSES = ["QUEUED", "SENT", "DELIVERED", "FAILED"] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export const DOCUMENT_KINDS = ["PDF", "XLSX"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const STAGED_RECORD_STATUSES = [
  "PROPOSED",
  "APPROVED",
  "EDITED_APPROVED",
  "REJECTED",
  "MERGED",
] as const;
export type StagedRecordStatus = (typeof STAGED_RECORD_STATUSES)[number];

/**
 * Phase B ingestion pipeline — a resumable per-document status machine. A
 * source_document advances REGISTERED → META_DONE → LINES_DONE → STAGED → DONE;
 * FAILED is terminal until the document is re-registered. The stages are
 * idempotent so a crashed run can resume from the last completed stage.
 */
export const SOURCE_DOC_STATUSES = [
  "REGISTERED",
  "META_DONE",
  "LINES_DONE",
  "STAGED",
  "DONE",
  "FAILED",
] as const;
export type SourceDocStatus = (typeof SOURCE_DOC_STATUSES)[number];

/** Lifecycle of one LLM extraction pass over a source document. */
export const EXTRACTION_RUN_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED"] as const;
export type ExtractionRunStatus = (typeof EXTRACTION_RUN_STATUSES)[number];

/** Which master a staged_record proposes to write when committed. */
export const TARGET_MASTERS = ["materials", "makes", "prices", "install_rates"] as const;
export type TargetMaster = (typeof TARGET_MASTERS)[number];

/** Kind of retrieval chunk emitted for a source document (rag_chunks.chunk_kind). */
export const CHUNK_KINDS = ["doc_summary", "boq_section", "terms"] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];
