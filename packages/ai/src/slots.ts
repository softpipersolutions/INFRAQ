import { enquiryInputSchema, type EnquiryInput } from "@pebble/shared";
import { z } from "zod";

/**
 * Chat slot-filling for enquiry capture (spec §4.4).
 *
 * The model only ever *extracts* field values; deterministic code owns the
 * conversation state: which slots are missing, what to ask next, and when the
 * record is complete. Each field is missing → proposed (extracted, awaiting
 * confirmation) → confirmed. The state lives in chat_sessions.slot_state.
 */

export type SlotStatus = "missing" | "proposed" | "confirmed";

export const SLOT_FIELDS = [
  "clientName",
  "projectName",
  "buildingType",
  "floorsAbove",
  "floorAreaSqm",
  "systemsRequired",
  "makePreference",
  "projectTier",
  "applicableStandard",
  "clientEmail",
  "clientPhone",
  "notes",
] as const;
export type SlotField = (typeof SLOT_FIELDS)[number];

interface FieldMeta {
  field: SlotField;
  required: boolean;
  question: string;
}

/** Ask order + prompts. applicableStandard/contacts/notes are optional. */
export const FIELD_META: FieldMeta[] = [
  { field: "clientName", required: true, question: "Who is the client (company/person)?" },
  { field: "projectName", required: true, question: "What is the project or site name?" },
  { field: "buildingType", required: true, question: "What is the building type (Residential, Commercial, Industrial, Institutional, Mixed)?" },
  { field: "floorsAbove", required: true, question: "How many floors above ground?" },
  { field: "floorAreaSqm", required: true, question: "What is the typical floor area in sqm?" },
  { field: "systemsRequired", required: true, question: "Which fire-safety systems are required (FAS, Hydrant, Sprinkler, Extinguisher, Suppression)?" },
  { field: "makePreference", required: true, question: "Any make preference (Premium, Standard, Economy, or 'As per Greenberg')?" },
  { field: "projectTier", required: true, question: "What is the project tier (1–4, by estimated value)?" },
  { field: "applicableStandard", required: false, question: "Which standard applies (defaults to IS)?" },
  { field: "clientEmail", required: false, question: "Client email for the quotation (optional)?" },
  { field: "clientPhone", required: false, question: "Client phone (optional)?" },
  { field: "notes", required: false, question: "Any other notes (optional)?" },
];

const REQUIRED_FIELDS = FIELD_META.filter((m) => m.required).map((m) => m.field);

export type SlotValue = string | number | string[] | null;

export interface Slot {
  status: SlotStatus;
  value: SlotValue;
}

export type SlotState = Record<SlotField, Slot>;

export function initSlotState(): SlotState {
  const state = {} as SlotState;
  for (const f of SLOT_FIELDS) state[f] = { status: "missing", value: null };
  return state;
}

/** Zod schema for a model's per-message extraction (all fields optional). */
export const extractionSchema = z
  .object({
    clientName: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    buildingType: z.string().optional(),
    floorsAbove: z.number().int().min(0).max(200).optional(),
    floorAreaSqm: z.number().positive().optional(),
    systemsRequired: z.array(z.string()).optional(),
    makePreference: z.string().optional(),
    projectTier: z.number().int().min(1).max(4).optional(),
    applicableStandard: z.string().optional(),
    clientEmail: z.string().optional(),
    clientPhone: z.string().optional(),
    notes: z.string().optional(),
  })
  .partial();
export type ExtractedFields = z.infer<typeof extractionSchema>;

/**
 * Fold freshly-extracted fields into the state as PROPOSED values. Already
 * confirmed slots are left untouched unless the new value differs (a proposed
 * correction the user can confirm).
 */
export function applyExtracted(state: SlotState, extracted: ExtractedFields): SlotState {
  const next: SlotState = structuredCloneState(state);
  for (const f of SLOT_FIELDS) {
    const raw = extracted[f];
    if (raw === undefined) continue;
    const value = raw as SlotValue;
    const existing = next[f];
    if (existing.status === "confirmed" && slotEquals(existing.value, value)) continue;
    next[f] = { status: "proposed", value };
  }
  return next;
}

/** Mark a specific slot confirmed (must already have a value). */
export function confirmSlot(state: SlotState, field: SlotField): SlotState {
  const next = structuredCloneState(state);
  if (next[field].value !== null) next[field] = { status: "confirmed", value: next[field].value };
  return next;
}

/** Confirm every currently-proposed slot (user accepts the summary card). */
export function confirmAllProposed(state: SlotState): SlotState {
  const next = structuredCloneState(state);
  for (const f of SLOT_FIELDS) {
    if (next[f].status === "proposed") next[f] = { status: "confirmed", value: next[f].value };
  }
  return next;
}

export type NextAction =
  | { kind: "ask"; field: SlotField; question: string }
  | { kind: "confirm"; fields: SlotField[] }
  | { kind: "complete" };

/**
 * What the conversation should do next: ask for the next missing required
 * field, present proposed values for confirmation, or complete.
 */
export function nextAction(state: SlotState): NextAction {
  for (const meta of FIELD_META) {
    if (meta.required && state[meta.field].status === "missing") {
      return { kind: "ask", field: meta.field, question: meta.question };
    }
  }
  const proposed = REQUIRED_FIELDS.filter((f) => state[f].status === "proposed");
  if (proposed.length > 0) return { kind: "confirm", fields: proposed };
  return { kind: "complete" };
}

export function allRequiredConfirmed(state: SlotState): boolean {
  return REQUIRED_FIELDS.every((f) => state[f].status === "confirmed");
}

export interface BuildResult {
  ok: boolean;
  input?: EnquiryInput;
  issues?: string[];
}

/**
 * Assemble a validated EnquiryInput from the confirmed slots (defaults filled:
 * applicableStandard IS, source chat). Validation reuses the SAME zod schema
 * the structured form uses — chat and form can never diverge.
 */
export function buildEnquiryInput(state: SlotState): BuildResult {
  const get = (f: SlotField): SlotValue => state[f].value;
  const candidate = {
    clientName: get("clientName"),
    projectName: get("projectName"),
    buildingType: get("buildingType"),
    floorsAbove: get("floorsAbove"),
    floorAreaSqm: get("floorAreaSqm"),
    systemsRequired: get("systemsRequired"),
    makePreference: get("makePreference"),
    applicableStandard: get("applicableStandard") ?? "IS",
    projectTier: get("projectTier"),
    clientEmail: (get("clientEmail") as string | null) ?? null,
    clientPhone: (get("clientPhone") as string | null) ?? null,
    notes: (get("notes") as string | null) ?? null,
    source: "chat" as const,
  };
  const parsed = enquiryInputSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, input: parsed.data };
  return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

function slotEquals(a: SlotValue, b: SlotValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

function structuredCloneState(state: SlotState): SlotState {
  const next = {} as SlotState;
  for (const f of SLOT_FIELDS) {
    const s = state[f];
    next[f] = { status: s.status, value: Array.isArray(s.value) ? [...s.value] : s.value };
  }
  return next;
}
