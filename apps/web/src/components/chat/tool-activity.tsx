"use client";

import { formatINR } from "@/lib/format";
import { Card } from "@/components/ui";

/**
 * Loose shape for a streamed/hydrated tool part. Deliberately wider than the AI
 * SDK's `ToolUIPart`/`DynamicToolUIPart` (which both structurally satisfy it) so
 * this module stays decoupled from the exact TOOLS type param — every field but
 * `type` is optional and every value is treated as unknown until narrowed.
 */
export interface ToolPart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

/** True for AI SDK message parts that represent a tool call (static or dynamic). */
export function isToolPart(part: { type: string }): part is ToolPart {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

/** The tool name behind a part, regardless of whether it's a static `tool-<name>` or `dynamic-tool` part. */
export function toolNameFromPart(part: ToolPart): string {
  if (part.type === "dynamic-tool") return part.toolName ?? "tool";
  return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : part.type;
}

/** Human labels for the 15 Module-02 tools (spec §Phase C.5 WP4); unknown tools get a prettified fallback. */
const TOOL_LABELS: Record<string, string> = {
  lookup_material: "Looked up material",
  search_past_estimates: "Searched past quotes",
  get_design_rules: "Checked design rules",
  update_enquiry_draft: "Updated the enquiry draft",
  extract_enquiry_fields: "Read the details",
  create_enquiry: "Created the enquiry",
  get_enquiry_state: "Checked capture state",
  repair_enquiry_state: "Fixed the capture state",
  reset_enquiry_capture: "Reset the capture",
  prepare_documents: "Prepared documents",
  get_current_price: "Checked a rate",
  explain_line: "Pulled the line's audit trail",
  get_estimate_version: "Opened the estimate",
  list_makes_for_material: "Checked approved makes",
  propose_line_edit: "Drafted an edit suggestion",
};

/** `toolLabel("lookup_material")` -> `"Looked up material"`; unknown tools fall back to a prettified name. */
export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? prettifyToolName(toolName);
}

function prettifyToolName(toolName: string): string {
  const spaced = toolName.replace(/_/g, " ").trim();
  if (!spaced) return "Used a tool";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Best-effort one-line summary of a tool's output, for the compact "done" row.
 * Outputs are unknown-shaped (they come off the wire / out of jsonb) so every
 * lookup is defensive — this must never throw.
 */
export function toolSummary(toolName: string, output: unknown): string | null {
  try {
    switch (toolName) {
      // create_enquiry renders as a ReceiptCard instead of a summary line.
      case "create_enquiry":
        return null;

      case "get_design_rules": {
        if (!Array.isArray(output)) return null;
        const first = output[0];
        if (!isRecord(first)) return output.length === 0 ? "No matching rules" : null;
        const code = isNonEmptyString(first.ruleCode) ? first.ruleCode : null;
        const ref = isNonEmptyString(first.standardReference) ? first.standardReference : null;
        const joined = [code, ref].filter(Boolean).join(" — ");
        return joined.length > 0 ? joined : null;
      }

      case "search_past_estimates": {
        if (!Array.isArray(output)) return null;
        if (output.length === 0) return "No matching past quotes";
        const first = output[0];
        return isRecord(first) && isNonEmptyString(first.sourceFilename) ? first.sourceFilename : null;
      }

      case "lookup_material": {
        if (output === null) return "Not found";
        if (!isRecord(output)) return null;
        return isNonEmptyString(output.materialName) ? output.materialName : null;
      }

      case "list_makes_for_material": {
        if (!Array.isArray(output)) return null;
        if (output.length === 0) return "No approved makes";
        return `${output.length} make${output.length === 1 ? "" : "s"}`;
      }

      case "get_current_price": {
        if (output === null) return "No price on file";
        if (!isRecord(output)) return null;
        const paise = output.sellingRatePaise;
        return typeof paise === "number" && Number.isInteger(paise) ? formatINR(paise) : null;
      }

      case "get_estimate_version": {
        if (!isRecord(output)) return null;
        return isNonEmptyString(output.estimateId) ? output.estimateId : null;
      }

      case "explain_line": {
        if (!isRecord(output)) return null;
        const code = isNonEmptyString(output.ruleCode) ? output.ruleCode : null;
        const ref = isNonEmptyString(output.standardReference) ? output.standardReference : null;
        const joined = [code, ref].filter(Boolean).join(" — ");
        return joined.length > 0 ? joined : null;
      }

      case "get_enquiry_state": {
        if (!isRecord(output)) return null;
        if (typeof output.readyToConfirm === "boolean") {
          return output.readyToConfirm ? "Ready to confirm" : "Still capturing";
        }
        return null;
      }

      case "update_enquiry_draft":
      case "extract_enquiry_fields": {
        if (!isRecord(output)) return null;
        if (isNonEmptyString(output.nextQuestion)) return output.nextQuestion;
        if (output.complete === true) return "Capture complete";
        return null;
      }

      case "prepare_documents": {
        if (!isRecord(output)) return null;
        return output.ok === true ? "Queued" : null;
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** True for a successful `create_enquiry` tool part — the trigger for rendering a ReceiptCard instead of a row. */
export function isCreateEnquirySuccessPart(part: ToolPart): boolean {
  return (
    toolNameFromPart(part) === "create_enquiry" &&
    part.state === "output-available" &&
    isRecord(part.output) &&
    part.output.ok === true
  );
}

const PENDING_STATES = new Set(["input-streaming", "input-available"]);

/**
 * One line of live/replayed tool activity: a pulse while the tool is running,
 * then a compact "done" row (icon dot + label + best-effort summary), or a red
 * error row with the tool's `errorText`.
 */
export function ToolActivityRow({ part }: { part: ToolPart }) {
  const toolName = toolNameFromPart(part);
  const label = toolLabel(toolName);
  const state = part.state ?? "output-available";

  if (PENDING_STATES.has(state)) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--pebble-muted)]">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--pebble-accent)]" />
        <span>{label}…</span>
      </div>
    );
  }

  if (state === "output-error") {
    return (
      <div className="flex items-start gap-2 text-xs text-red-700">
        <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
        <span>
          <span className="font-medium">{label} — failed.</span>
          {part.errorText ? <span> {part.errorText}</span> : null}
        </span>
      </div>
    );
  }

  const summary = toolSummary(toolName, part.output);
  return (
    <div className="flex items-start gap-2 text-xs text-[var(--pebble-muted)]">
      <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
      <span>
        <span className="font-medium text-[var(--pebble-ink)]">{label}</span>
        {summary ? <span> — {summary}</span> : null}
      </span>
    </div>
  );
}

/**
 * Renders a `create_enquiry` success output as a bordered receipt (enquiry no.,
 * estimate no., open link). Renders nothing for a refusal (`{ok:false, issues}`)
 * — the agent explains those in its own text reply.
 */
export function ReceiptCard({ output }: { output: unknown }) {
  if (!isRecord(output) || output.ok !== true) return null;
  const enquiryId = isNonEmptyString(output.enquiryId) ? output.enquiryId : null;
  const estimateId = isNonEmptyString(output.estimateId) ? output.estimateId : null;
  if (!enquiryId || !estimateId) return null;

  return (
    <Card className="border-emerald-200 bg-emerald-50 p-3">
      <div className="text-sm font-semibold text-emerald-900">Enquiry created</div>
      <dl className="mt-1 text-sm text-emerald-800">
        <div>
          <dt className="inline font-medium">Enquiry no. </dt>
          <dd className="inline">{enquiryId}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Estimate no. </dt>
          <dd className="inline">{estimateId}</dd>
        </div>
      </dl>
      <a
        href={`/estimates/${estimateId}`}
        className="mt-2 inline-block text-sm font-medium text-emerald-900 underline"
      >
        Open estimate
      </a>
    </Card>
  );
}
