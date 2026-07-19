import {
  buildEnquiryInput,
  FIELD_META,
  nextAction,
  type SlotField,
  type SlotState,
  type SlotValue,
} from "../slots";

/**
 * The session-state context block (Phase C.5).
 *
 * A short, FRESH (never-cached) advisory block appended to the conversation
 * suffix each turn. It tells the agent where enquiry capture stands — progress,
 * proposed/missing fields, whether the record validates, what is linked, and a
 * SUGGESTED (not scripted) next step derived from the slot machine. The slot
 * machine is state the tools read/write; this block surfaces that state to the
 * model without dictating the reply. Pure and unit-tested.
 */

const REQUIRED_FIELDS: SlotField[] = FIELD_META.filter((m) => m.required).map((m) => m.field);

export interface EstimateSummary {
  estimateId: string;
  sitcStatus: string;
  versionNo: number;
}

export function buildSessionStateBlock(args: {
  slotState: SlotState;
  enquiryId: string | null;
  estimateSummary?: EstimateSummary | null;
  contradictions: number;
}): string {
  const { slotState, enquiryId, estimateSummary, contradictions } = args;

  const confirmed: string[] = [];
  const proposed: string[] = [];
  const missingRequired: string[] = [];
  let confirmedRequired = 0;

  for (const meta of FIELD_META) {
    const slot = slotState[meta.field];
    if (slot.status === "confirmed") {
      confirmed.push(`${meta.field}=${fmtValue(slot.value)}`);
      if (meta.required) confirmedRequired += 1;
    } else if (slot.status === "proposed") {
      proposed.push(`${meta.field}=${fmtValue(slot.value)}`);
    } else if (meta.required) {
      missingRequired.push(meta.field);
    }
  }

  const built = buildEnquiryInput(slotState);
  const validation = built.ok
    ? "validates cleanly"
    : `not ready — ${summariseIssues(built.issues ?? [])}`;
  const readyToConfirm = built.ok && missingRequired.length === 0;

  const lines: string[] = [];
  lines.push("## Enquiry capture (session state — advisory, not a script)");
  lines.push(`Captured: ${confirmedRequired}/${REQUIRED_FIELDS.length} required fields confirmed.`);
  lines.push(`Confirmed: ${confirmed.length ? confirmed.join(", ") : "—"}`);
  lines.push(`Proposed (awaiting user yes): ${proposed.length ? proposed.join(", ") : "—"}`);
  lines.push(`Still needed (required): ${missingRequired.length ? missingRequired.join(", ") : "—"}`);
  lines.push(`Validation: ${validation}`);
  lines.push(`Ready to confirm: ${readyToConfirm ? "yes" : "no"}`);
  lines.push(linkLine(enquiryId, estimateSummary ?? null));
  lines.push(`Contradictions logged this session: ${contradictions}`);
  lines.push(`Suggested next step (advisory): ${suggestedNextStep(slotState, enquiryId)}`);

  return lines.join("\n");
}

function linkLine(enquiryId: string | null, estimate: EstimateSummary | null): string {
  if (!enquiryId) return "Linked: no enquiry created yet.";
  if (estimate) {
    return `Linked: enquiry ${enquiryId}, estimate ${estimate.estimateId} v${estimate.versionNo} (SITC ${estimate.sitcStatus}).`;
  }
  return `Linked: enquiry ${enquiryId} (no estimate summary loaded).`;
}

function suggestedNextStep(state: SlotState, enquiryId: string | null): string {
  if (enquiryId) {
    return "an enquiry already exists for this session — do not create another; help with the estimate or answer questions.";
  }
  const na = nextAction(state);
  if (na.kind === "ask") {
    return `capture is incomplete — naturally ask about ${na.field} (${na.question}), plus any other missing fields.`;
  }
  if (na.kind === "confirm") {
    return `all required fields are proposed — restate the full record (${na.fields.join(", ")}) and get an explicit yes before create_enquiry.`;
  }
  return "the record is complete and confirmed — restate it and, on an explicit yes, call create_enquiry.";
}

function summariseIssues(issues: string[]): string {
  if (issues.length === 0) return "no details captured yet";
  const shown = issues.slice(0, 4).join("; ");
  return issues.length > 4 ? `${shown}; …(+${issues.length - 4} more)` : shown;
}

function fmtValue(v: SlotValue): string {
  if (v === null) return "—";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
