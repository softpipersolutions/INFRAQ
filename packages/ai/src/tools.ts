import type {
  DesignRule,
  EnquiryInput,
  Make,
  Material,
  Price,
  PricedLine,
  SystemType,
} from "@pebble/shared";
import type { ExtractedFields, SlotField, SlotStatus, SlotValue } from "./slots";

/**
 * The `PebbleAiServices` interface + the result types the Module-02 toolset
 * (`agent/module02.ts`) and its `apps/web` implementation share (spec §4.4).
 *
 * Two hard boundaries live in this surface:
 *   - read/lookup/RAG tools return facts the model explains from;
 *   - the model can PROPOSE a line edit but never apply one (`proposeLineEdit`
 *     returns a suggestion; a human clicks to apply).
 * Injecting the services keeps the tools testable without a database.
 *
 * NOTE (Phase C.5): the canonical toolset is `agent/module02.ts`
 * (`module02Toolset`). The Phase-C.5 state-machine methods (extractFields,
 * createEnquiryFromState, getEnquiryState, repairEnquiryState,
 * resetEnquiryCapture, prepareDocuments) are declared OPTIONAL here so a
 * consumer that only needs the read/RAG surface still satisfies the interface;
 * `apps/web` implements them all.
 */

export interface PastEstimateHit {
  sourceFilename: string;
  snippet: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface SlotUpdateResult {
  /** Next question to ask, or null when the record is ready to confirm. */
  nextQuestion: string | null;
  complete: boolean;
}

export interface EstimateVersionView {
  estimateId: string;
  versionNo: number;
  state: string;
  lines: PricedLine[];
  totalSitcPaise: number;
  blendedRatio: number | null;
}

export interface LineExplanation {
  lineUid: string;
  materialCode: string;
  ruleCode: string | null;
  standardReference: string | null;
  /** RULE_APPLIED / PRICE_APPLIED audit payloads that produced this line. */
  auditPayloads: Record<string, unknown>[];
}

export interface LineEditSuggestion {
  estimateId: string;
  lineUid: string;
  proposed: Record<string, unknown>;
  rationale: string;
  /** Always false — the model cannot mutate an estimate. */
  applied: false;
}

/**
 * A snapshot of enquiry-capture state a tool returns for the agent to narrate.
 * Per-field status + value, the confirmed/proposed/missing splits, the
 * `buildEnquiryInput` validation issues, readiness, and any linked records.
 */
export interface EnquiryStateSnapshot {
  slots: Record<SlotField, { status: SlotStatus; value: SlotValue }>;
  confirmed: SlotField[];
  proposed: SlotField[];
  missingRequired: SlotField[];
  /** Validation issues from `buildEnquiryInput` (empty when the record validates). */
  issues: string[];
  readyToConfirm: boolean;
  enquiryId: string | null;
  estimateId: string | null;
  /** Advisory (not prescriptive) suggestion for what to do next. */
  advisoryNextStep: string;
}

/** Result of `createEnquiryFromState` — refuses (ok:false, issues) when invalid or already linked. */
export type CreateEnquiryResult =
  | { ok: true; enquiryId: string; estimateId: string | null }
  | { ok: false; issues: string[] };

/** Typed corrections for `repairEnquiryState`: overwrite `set` fields, clear `clear` fields. */
export interface RepairEnquiryArgs {
  set?: ExtractedFields;
  clear?: SlotField[];
}

/** Result of `repairEnquiryState` — refuses (ok:false, issues) once an enquiry is linked. */
export type RepairEnquiryResult =
  | { ok: true; snapshot: EnquiryStateSnapshot }
  | { ok: false; issues: string[] };

/** Result of `prepareDocuments` — the worker-client render outcome (LOCKED-only errors pass through). */
export interface PrepareDocumentsResult {
  ok: boolean;
  estimateId: string;
  jobId?: string;
  status?: string;
  issues?: string[];
}

/** The service surface the tools call — implemented in apps/web against db + engines. */
export interface PebbleAiServices {
  lookupMaterial(materialCode: string): Promise<Material | null>;
  listMakesForMaterial(materialCode: string): Promise<Make[]>;
  getCurrentPrice(materialCode: string, makeCode: string): Promise<Price | null>;
  searchPastEstimates(query: string, limit: number): Promise<PastEstimateHit[]>;
  getDesignRules(systemType: SystemType | null): Promise<DesignRule[]>;
  updateEnquiryDraft(sessionId: string, fields: ExtractedFields): Promise<SlotUpdateResult>;
  createEnquiry(input: EnquiryInput): Promise<{ enquiryId: string }>;
  getEstimateVersion(estimateId: string, versionNo: number | null): Promise<EstimateVersionView | null>;
  explainLine(estimateId: string, lineUid: string): Promise<LineExplanation | null>;
  proposeLineEdit(args: {
    estimateId: string;
    lineUid: string;
    qty?: number;
    makeCode?: string;
    note?: string;
    editReason: string;
  }): Promise<LineEditSuggestion>;

  // ── Phase C.5 state-machine ops (Module-02 toolset). Optional so the current
  // apps/web impl still satisfies the interface; WP3 implements them. ──────────

  /** Extract enquiry fields from long pasted text (Gemini Flash), auto-apply as proposed, return the snapshot. */
  extractFields?(text: string): Promise<EnquiryStateSnapshot>;
  /** Derive the enquiry record from confirmed slot state and create it; refuses when invalid or already linked. */
  createEnquiryFromState?(sessionId: string): Promise<CreateEnquiryResult>;
  /** Full capture state + validation issues + readiness + linked enquiry/estimate — the self-heal diagnosis tool. */
  getEnquiryState?(sessionId: string): Promise<EnquiryStateSnapshot>;
  /** Typed corrections to the capture state; blocked once an enquiry is linked. */
  repairEnquiryState?(sessionId: string, args: RepairEnquiryArgs): Promise<RepairEnquiryResult>;
  /** Agent-callable start-over (explicit user request only). */
  resetEnquiryCapture?(sessionId: string): Promise<EnquiryStateSnapshot>;
  /** Queue PDF/Excel render for a LOCKED estimate version via the worker-client. */
  prepareDocuments?(estimateId: string): Promise<PrepareDocumentsResult>;
}
