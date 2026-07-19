import type {
  DesignRule,
  EnquiryInput,
  Make,
  Material,
  Price,
  PricedLine,
  SystemType,
} from "@pebble/shared";
import { SYSTEM_TYPES, enquiryInputSchema } from "@pebble/shared";
import { tool } from "ai";
import { z } from "zod";
import type { ExtractedFields, SlotField, SlotStatus, SlotValue } from "./slots";

/**
 * Tool definitions for the AI lanes (spec §4.4) — thin wrappers over injected
 * services. Two hard boundaries are encoded here:
 *   - read/lookup/RAG tools return facts the model explains from;
 *   - the model can PROPOSE a line edit but never apply one (propose_line_edit
 *     returns a suggestion; a human clicks to apply).
 * Injecting the services keeps the tools testable without a database.
 *
 * NOTE (Phase C.5): the canonical toolset is now `agent/module02.ts`
 * (`module02Toolset`). `buildPebbleTools` below is kept as a deprecated compat
 * shim over the SAME `PebbleAiServices` surface until WP3 rewires the route.
 * The new state-machine service methods (extractFields, createEnquiryFromState,
 * getEnquiryState, repairEnquiryState, resetEnquiryCapture, prepareDocuments)
 * are declared here as OPTIONAL so the existing apps/web impl still satisfies
 * the interface; WP3 implements them.
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

/**
 * @deprecated Phase C.5 replaces this with `module02Toolset` (agent/module02.ts),
 * which adds the typed `update_enquiry_draft`, the safety-upgraded `create_enquiry`
 * (`{userConfirmed}` → create-from-state), and the self-heal tools. Kept as a
 * compat shim (identical old tool set + behaviour) so the existing /api/chat
 * route keeps working until WP3 rewires it; do not build new callers on this.
 */
export function buildPebbleTools(services: PebbleAiServices) {
  return {
    lookup_material: tool({
      description: "Look up a material by its code (e.g. FAS-SMK-001). Returns null if unknown.",
      inputSchema: z.object({ materialCode: z.string().min(1) }),
      execute: ({ materialCode }) => services.lookupMaterial(materialCode),
    }),

    list_makes_for_material: tool({
      description: "List the approved/available makes (brands) for a material, with tier and approval status.",
      inputSchema: z.object({ materialCode: z.string().min(1) }),
      execute: ({ materialCode }) => services.listMakesForMaterial(materialCode),
    }),

    get_current_price: tool({
      description: "Get the current effective supply price for a material + make (integer paise).",
      inputSchema: z.object({ materialCode: z.string().min(1), makeCode: z.string().min(1) }),
      execute: ({ materialCode, makeCode }) => services.getCurrentPrice(materialCode, makeCode),
    }),

    search_past_estimates: tool({
      description:
        "Retrieve relevant historical Greenberg proposals ('what did we quote before?'). Returns cited source filenames with snippets.",
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).default(5) }),
      execute: ({ query, limit }) => services.searchPastEstimates(query, limit),
    }),

    get_design_rules: tool({
      description: "List active design rules (A.06), optionally filtered by system, with their conditions, formulas and standard references.",
      inputSchema: z.object({ systemType: z.enum(SYSTEM_TYPES).nullable().default(null) }),
      execute: ({ systemType }) => services.getDesignRules(systemType),
    }),

    update_enquiry_draft: tool({
      description: "Update the in-progress enquiry slot-filling draft with newly-mentioned fields. Returns the next question or completeness.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        fields: z.record(z.string(), z.unknown()),
      }),
      execute: ({ sessionId, fields }) => services.updateEnquiryDraft(sessionId, fields as ExtractedFields),
    }),

    create_enquiry: tool({
      description: "Create the enquiry record from confirmed slot values. Validates via the same schema as the form, then triggers deterministic generation.",
      inputSchema: enquiryInputSchema,
      execute: (input) => services.createEnquiry(input as EnquiryInput),
    }),

    get_estimate_version: tool({
      description: "Fetch an estimate version (defaults to current) with its lines and SITC totals.",
      inputSchema: z.object({ estimateId: z.string().min(1), versionNo: z.number().int().nullable().default(null) }),
      execute: ({ estimateId, versionNo }) => services.getEstimateVersion(estimateId, versionNo),
    }),

    explain_line: tool({
      description:
        "Explain why a line exists: the rule code, standard reference and RULE_APPLIED/PRICE_APPLIED audit payloads behind it. Explain from these facts only.",
      inputSchema: z.object({ estimateId: z.string().min(1), lineUid: z.string().min(1) }),
      execute: ({ estimateId, lineUid }) => services.explainLine(estimateId, lineUid),
    }),

    propose_line_edit: tool({
      description:
        "Propose a change to a line (qty/make/note). This is a SUGGESTION ONLY — it is never applied automatically; a human must approve it. Returns the proposal.",
      inputSchema: z.object({
        estimateId: z.string().min(1),
        lineUid: z.string().min(1),
        qty: z.number().nonnegative().optional(),
        makeCode: z.string().optional(),
        note: z.string().optional(),
        editReason: z.string().min(1),
      }),
      execute: (args) => services.proposeLineEdit(args),
    }),
  };
}

export type PebbleTools = ReturnType<typeof buildPebbleTools>;
