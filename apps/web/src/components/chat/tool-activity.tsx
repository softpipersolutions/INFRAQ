"use client";

import {
  AlertCircle,
  BookOpen,
  Brain,
  ClipboardEdit,
  FileDown,
  FileOutput,
  FilePlus,
  FileSearch,
  FileText,
  HelpCircle,
  IndianRupee,
  List,
  Package,
  Paperclip,
  PenLine,
  RotateCcw,
  ScanText,
  Search,
  Wrench,
  type LucideIcon,
} from "lucide-react";
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
  list_attachments: "Listed attachments",
  read_attachment: "Read an attached file",
  analyze_office_file: "Analyzed an Office file",
  generate_file: "Generated a file",
};

/** `toolLabel("lookup_material")` -> `"Looked up material"`; unknown tools fall back to a prettified name. */
export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? prettifyToolName(toolName);
}

/** Per-tool glyph for the activity row (size 14-16, strokeWidth 1.5, text-ink-muted by default). Unknown tools fall back to `DEFAULT_TOOL_ICON`. */
const TOOL_ICONS: Record<string, LucideIcon> = {
  lookup_material: Package,
  search_past_estimates: Search,
  get_design_rules: BookOpen,
  update_enquiry_draft: ClipboardEdit,
  extract_enquiry_fields: ScanText,
  create_enquiry: FilePlus,
  get_enquiry_state: Wrench,
  repair_enquiry_state: Wrench,
  reset_enquiry_capture: RotateCcw,
  prepare_documents: FileOutput,
  get_current_price: IndianRupee,
  explain_line: HelpCircle,
  get_estimate_version: FileText,
  list_makes_for_material: List,
  propose_line_edit: PenLine,
  list_attachments: Paperclip,
  read_attachment: FileText,
  analyze_office_file: FileSearch,
  generate_file: FileDown,
};

const DEFAULT_TOOL_ICON: LucideIcon = Wrench;

/** `toolIcon("lookup_material")` -> `Package`; unknown tools fall back to a generic icon. */
export function toolIcon(toolName: string): LucideIcon {
  return TOOL_ICONS[toolName] ?? DEFAULT_TOOL_ICON;
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
      // create_enquiry renders as a ReceiptCard instead of a summary line;
      // a successful generate_file renders as a GenerateFileCard.
      case "create_enquiry":
        return null;

      case "generate_file": {
        if (!isRecord(output)) return null;
        if (output.ok === true) return null; // success → download card
        return isNonEmptyString(output.error) ? output.error : "Could not generate the file";
      }

      case "list_attachments": {
        if (!Array.isArray(output)) return null;
        return output.length === 0
          ? "No files uploaded yet"
          : `${output.length} file${output.length === 1 ? "" : "s"}`;
      }

      case "read_attachment": {
        if (!isRecord(output)) return null;
        if (isNonEmptyString(output.filename)) return output.filename;
        if (isNonEmptyString(output.note)) return output.note;
        return null;
      }

      case "analyze_office_file": {
        if (!isRecord(output)) return null;
        if (output.ok === true) return isNonEmptyString(output.filename) ? output.filename : "Analyzed";
        return isNonEmptyString(output.error) ? output.error : null;
      }

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

/** True for a successful `generate_file` tool part — the trigger for rendering a GenerateFileCard (a download card) instead of a row. */
export function isGenerateFileSuccessPart(part: ToolPart): boolean {
  return (
    toolNameFromPart(part) === "generate_file" &&
    part.state === "output-available" &&
    isRecord(part.output) &&
    part.output.ok === true &&
    isNonEmptyString(part.output.attachmentId)
  );
}

/** True for a `memory` tool part (WP9) — rendered as a subtle one-liner, not a full activity row. */
export function isMemoryPart(part: ToolPart): boolean {
  return toolNameFromPart(part) === "memory";
}

/** The memory-tool write commands (everything but `view` mutates the store). */
const MEMORY_WRITE_COMMANDS = new Set(["create", "str_replace", "insert", "delete", "rename"]);

/**
 * Derive the memory indicator's label + path from a `memory` tool call's input.
 * `view` reads ("Checked memory"); create/str_replace/insert/delete/rename write
 * ("Updated memory"). The path is `input.path`, or `input.new_path` for a rename.
 * Defensive — the input is unknown-shaped (off the wire / out of jsonb).
 */
export function memoryIndicator(input: unknown): { label: string; path: string | null } {
  if (!isRecord(input)) return { label: "Used memory", path: null };
  const command = typeof input.command === "string" ? input.command : "";
  const path = isNonEmptyString(input.path)
    ? input.path
    : isNonEmptyString(input.new_path)
      ? input.new_path
      : null;
  if (command === "view") return { label: "Checked memory", path };
  if (MEMORY_WRITE_COMMANDS.has(command)) return { label: "Updated memory", path };
  return { label: "Used memory", path };
}

/**
 * A subtle one-line memory indicator (WP9): a Brain glyph, "Checked memory"
 * (view) or "Updated memory" (writes), and the file path — never a full activity
 * row. An errored call shows the danger tint with the tool's `errorText`.
 */
export function MemoryActivityRow({ part }: { part: ToolPart }) {
  const { label, path } = memoryIndicator(part.input);
  const state = part.state ?? "output-available";
  const pending = PENDING_STATES.has(state);

  if (state === "output-error") {
    return (
      <div className="flex items-start gap-2 text-xs text-danger">
        <Brain size={14} strokeWidth={1.5} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          <span className="font-medium">Memory — failed.</span>
          {part.errorText ? <span> {part.errorText}</span> : null}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs text-ink-muted">
      <Brain
        size={14}
        strokeWidth={1.5}
        className={`shrink-0 text-ink-muted/70${pending ? " animate-pulse" : ""}`}
        aria-hidden
      />
      <span>
        <span className="font-medium">
          {label}
          {pending ? "…" : ""}
        </span>
        {path ? <span className="text-ink-muted"> · {path}</span> : null}
      </span>
    </div>
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
  const Icon = toolIcon(toolName);

  if (PENDING_STATES.has(state)) {
    // WP5 streaming feel: once the tool's input has fully arrived and it is
    // actually executing (`input-available`), the label gets a subtle
    // shimmer sweep instead of the plain pulse used while the input itself
    // is still streaming in (`input-streaming`) — a running tool "feels"
    // different from one still being called. `.shimmer-text` degrades to a
    // plain muted label under `prefers-reduced-motion: reduce`.
    const isRunning = state === "input-available";
    return (
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <Icon size={14} strokeWidth={1.5} className="shrink-0 animate-pulse text-ink-muted/40" aria-hidden />
        <span className={isRunning ? "shimmer-text font-medium" : undefined}>{label}…</span>
      </div>
    );
  }

  if (state === "output-error") {
    return (
      <div className="flex items-start gap-2 text-xs text-danger">
        <AlertCircle size={14} strokeWidth={1.5} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          <span className="font-medium">{label} — failed.</span>
          {part.errorText ? <span> {part.errorText}</span> : null}
        </span>
      </div>
    );
  }

  const summary = toolSummary(toolName, part.output);
  // WP13: a finished tool with a null/empty output and no summary of its own
  // gets a neutral "Tool returned no result" caption rather than a bare label.
  const fallback = summary === null && isEmptyToolOutput(part.output) ? "Tool returned no result" : null;
  return (
    <div className="flex items-start gap-2 text-xs text-ink-muted">
      <Icon size={14} strokeWidth={1.5} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden />
      <span>
        <span className="font-medium text-ink">{label}</span>
        {summary ? <span> — {summary}</span> : fallback ? <span> — {fallback}</span> : null}
      </span>
    </div>
  );
}

/** True when a finished tool's output carries nothing renderable: null/undefined, an empty array/object, or an empty string. */
export function isEmptyToolOutput(output: unknown): boolean {
  if (output === null || output === undefined) return true;
  if (typeof output === "string") return output.length === 0;
  if (Array.isArray(output)) return output.length === 0;
  if (typeof output === "object") return Object.keys(output as Record<string, unknown>).length === 0;
  return false;
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
    <Card className="p-3">
      <div className="text-sm font-semibold text-ink">Enquiry created</div>
      <dl className="mt-1 text-sm text-ink">
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
        className="mt-2 inline-block text-sm font-medium text-ink underline"
      >
        Open estimate
      </a>
    </Card>
  );
}

/**
 * Renders a successful `generate_file` output as a download card: a FileDown
 * glyph, the draft's filename, a DRAFT caption in muted ink, and a link to the
 * authenticated serve route. Renders nothing for a failure (the agent explains
 * those in its own text reply). The caption is load-bearing: the file is a
 * working draft, NEVER an official Greenberg document.
 */
export function GenerateFileCard({ output }: { output: unknown }) {
  if (!isRecord(output) || output.ok !== true) return null;
  const attachmentId = isNonEmptyString(output.attachmentId) ? output.attachmentId : null;
  const filename = isNonEmptyString(output.filename) ? output.filename : "Generated file";
  if (!attachmentId) return null;

  return (
    <Card className="p-3">
      <a
        href={`/api/chat/attachments/${attachmentId}`}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2.5 text-sm font-medium text-ink hover:underline"
      >
        <FileDown size={18} strokeWidth={1.75} className="shrink-0 text-ink-muted" aria-hidden />
        <span className="truncate">{filename}</span>
      </a>
      <p className="mt-1.5 text-xs text-ink-muted">
        DRAFT — generated by Pebble, not an official document.
      </p>
    </Card>
  );
}
