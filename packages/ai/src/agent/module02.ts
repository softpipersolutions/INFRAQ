import { SYSTEM_TYPES } from "@pebble/shared";
import { tool } from "ai";
import { z } from "zod";
import { extractionSchema, SLOT_FIELDS } from "../slots";
import type { ExtractedFields } from "../slots";
import type { PebbleAiServices } from "../tools";
import type { ModuleToolset } from "./registry";

/**
 * Module 02 — fire-safety estimate crafting — as a `ModuleToolset` (Phase C.5).
 *
 * This absorbs the whole legacy `tools.ts` tool set and applies the plan's
 * changes:
 *   - the eight read/RAG/explain tools are unchanged (propose stays
 *     suggestion-only);
 *   - `update_enquiry_draft` now takes the TYPED extraction fields and injects
 *     `sessionId` from the binding (the model can no longer steer it);
 *   - `create_enquiry` shrinks to `{userConfirmed: true}` and derives the record
 *     from the captured slot state (`createEnquiryFromState`), so what is created
 *     is exactly what the user saw and approved;
 *   - `extract_enquiry_fields`, `get_enquiry_state`, `repair_enquiry_state`,
 *     `reset_enquiry_capture` and `prepare_documents` are new.
 *
 * `sessionId` is bound here (never model-supplied) so a tool can only ever act on
 * the session that owns the turn. The new state-machine service methods are
 * optional on `PebbleAiServices` (WP3 implements them); they are guaranteed
 * present wherever this toolset is actually used, so we assert them.
 */
export function module02Toolset(
  services: PebbleAiServices,
  session: { sessionId: string },
): ModuleToolset {
  const { sessionId } = session;

  const tools = {
    // ── Read / retrieval / explain (unchanged from the legacy tool set) ───────
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
        "Retrieve relevant historical Greenberg proposals ('what did we quote before?'). Returns cited source filenames with snippets — cite them by filename.",
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).default(5) }),
      execute: ({ query, limit }) => services.searchPastEstimates(query, limit),
    }),

    get_design_rules: tool({
      description:
        "List active design rules (A.06), optionally filtered by system, with their conditions, formulas and standard references (IS refs). Cite the rule code + standard behind a quantity.",
      inputSchema: z.object({ systemType: z.enum(SYSTEM_TYPES).nullable().default(null) }),
      execute: ({ systemType }) => services.getDesignRules(systemType),
    }),

    get_estimate_version: tool({
      description: "Fetch an estimate version (defaults to current) with its lines and SITC totals.",
      inputSchema: z.object({ estimateId: z.string().min(1), versionNo: z.number().int().nullable().default(null) }),
      execute: ({ estimateId, versionNo }) => services.getEstimateVersion(estimateId, versionNo),
    }),

    explain_line: tool({
      description:
        "Explain why a line exists: the rule code, standard reference and RULE_APPLIED/PRICE_APPLIED audit payloads behind it. Explain from these facts only — never re-derive a figure.",
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

    // ── Enquiry capture (Phase C.5) ───────────────────────────────────────────
    update_enquiry_draft: tool({
      description:
        "Fold newly-mentioned enquiry fields into the capture draft as proposed values. Use for short conversational messages; for a long pasted email or spec dump use extract_enquiry_fields. The session is bound automatically — you do not pass an id.",
      // The typed extraction fields only — NO sessionId (it is injected from the binding).
      inputSchema: extractionSchema,
      execute: (fields: ExtractedFields) => services.updateEnquiryDraft(sessionId, fields),
    }),

    extract_enquiry_fields: tool({
      description:
        "Extract enquiry fields from a long pasted block of text (an email, a requirements dump). Auto-applies what it finds as proposed values and returns the capture snapshot. For short messages prefer update_enquiry_draft.",
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: ({ text }) => services.extractFields!(text),
    }),

    create_enquiry: tool({
      description:
        "Create the enquiry and generate the draft estimate from the CAPTURED slot state. Contract: only call this AFTER you have restated the complete record and the user has said yes — pass userConfirmed:true. The record is derived from slot state (you cannot pass values), so it is exactly what the user confirmed. Refuses with {ok:false, issues} if the record is invalid or an enquiry is already linked — read the issues and fix them conversationally, do not retry blindly.",
      inputSchema: z.object({ userConfirmed: z.literal(true) }),
      execute: () => services.createEnquiryFromState!(sessionId),
    }),

    get_enquiry_state: tool({
      description:
        "Diagnose the current capture state: every field's status and value, the validation issues, whether it is ready to confirm, and any linked enquiry/estimate. Use this first when the state looks off before repairing it.",
      inputSchema: z.object({}),
      execute: () => services.getEnquiryState!(sessionId),
    }),

    repair_enquiry_state: tool({
      description:
        "Fix specific capture fields: `set` overwrites fields with correct values, `clear` removes fields. Use to self-heal a stale or contradictory draft (get_enquiry_state first). Blocked once an enquiry is linked — you cannot rewrite a created enquiry.",
      inputSchema: z.object({
        set: extractionSchema.optional(),
        clear: z.array(z.enum(SLOT_FIELDS)).optional(),
      }),
      execute: (args) => services.repairEnquiryState!(sessionId, args),
    }),

    reset_enquiry_capture: tool({
      description:
        "Start the enquiry capture over from scratch. Only call this when the user EXPLICITLY asks to start over — never because a turn got confusing (diagnose and repair instead). Pass confirm:true.",
      inputSchema: z.object({ confirm: z.literal(true) }),
      execute: () => services.resetEnquiryCapture!(sessionId),
    }),

    prepare_documents: tool({
      description:
        "Queue the PDF/Excel document render for a LOCKED estimate version via the worker (audited, idempotent). Errors pass through — e.g. if the version is not LOCKED, relay that to the user. Never approve or dispatch — those are human-only.",
      inputSchema: z.object({ estimateId: z.string().min(1) }),
      execute: ({ estimateId }) => services.prepareDocuments!(estimateId),
    }),
  };

  return {
    id: "module02",
    title: "Module 02 — Fire-safety estimate crafting",
    promptFragment: MODULE02_FRAGMENT,
    tools,
    policy: {
      confirmRequired: ["create_enquiry"],
      humanOnly: ["approve_estimate", "dispatch_quote"],
    },
    // buildTurnContext intentionally unset — the /api/chat route builds the
    // session-state block via agent/context.ts (it holds the loaded slot state).
  };
}

/** Concise Module-02 domain guidance for the cached prefix (~300–500 tokens). */
export const MODULE02_FRAGMENT = `MODULE 02 — FIRE-SAFETY ESTIMATE CRAFTING
You are working the fire-safety estimating module. Your job is to capture a building enquiry and turn it into an auditable estimate; the deterministic engines do every calculation, you orchestrate and explain.

Capturing an enquiry (eight required fields): client, project, building type, floors above ground, typical floor area (sqm, per floor — never the building total), the exact systems requested (FAS / Hydrant / Sprinkler / Extinguisher / Suppression), make preference, and project tier (1–4).
- Short conversational messages → update_enquiry_draft (fields only; the session is bound for you).
- A long pasted email or spec dump → extract_enquiry_fields (one pass).
- Never add a system the client did not ask for; capture the exact set they named.

Creating the enquiry — the confirmation contract:
- Restate the COMPLETE captured record and ask a direct yes/no question.
- Only on an explicit yes, call create_enquiry with userConfirmed:true. The record is built from the captured slot state — you cannot pass values, so what is created is exactly what the user saw. It refuses (ok:false, issues) when invalid or already linked; read the issues and resolve them in conversation.

Self-healing a bad draft:
- If the state looks stale, contradictory, or holds a value the user did not give, call get_enquiry_state to see exactly what is held, then repair_enquiry_state to set/clear the specific fields, and continue.
- Only reset_enquiry_capture when the user explicitly asks to start over.

Explaining and adjusting:
- Cite the design rule code and standard reference (e.g. DL-FAS-001, IS 2189) behind a quantity, and the make/price behind a rate (get_design_rules, get_estimate_version, explain_line, lookup_material, list_makes_for_material, get_current_price).
- Bring up relevant past jobs unprompted via search_past_estimates and cite them by filename.
- propose_line_edit is a SUGGESTION only — a human applies every change.

The commercial rule: SITC = Supply × 1.43, acceptable band 1.35–1.51. If a draft's ratio is out of band, flag it plainly — never hide it.

Documents: prepare_documents queues the PDF/Excel render for a LOCKED version. Approving an estimate and dispatching a quote are human-only — you have no tool for them; point the user to the button.`;
