import type { SlotField, SlotValue } from "@pebble/ai";

/**
 * A.08 slot field display order + required flag, mirroring
 * packages/ai/src/slots.ts FIELD_META (field/required/question — same order).
 *
 * This is a deliberate, type-checked duplication rather than importing
 * FIELD_META itself: @pebble/ai's package barrel (src/index.ts) re-exports
 * ./ingest/model, which pulls in @ai-sdk/google-vertex -> google-auth-library
 * (node-only: fs/net/child_process). Any *value* import from "@pebble/ai" in
 * a client component drags that whole graph into the browser bundle and
 * breaks `next build`. `SlotField` below is a type-only import (erased at
 * compile time), so it carries no such risk while still catching drift if
 * slots.ts ever adds/removes/renames a field.
 */
export const SLOT_DISPLAY_ORDER: ReadonlyArray<{ field: SlotField; required: boolean }> = [
  { field: "clientName", required: true },
  { field: "projectName", required: true },
  { field: "buildingType", required: true },
  { field: "floorsAbove", required: true },
  { field: "floorAreaSqm", required: true },
  { field: "systemsRequired", required: true },
  { field: "makePreference", required: true },
  { field: "projectTier", required: true },
  { field: "applicableStandard", required: false },
  { field: "clientEmail", required: false },
  { field: "clientPhone", required: false },
  { field: "notes", required: false },
];

/** camelCase A.08 field name -> display label (e.g. "floorAreaSqm" -> "Floor area sqm"). */
export function fieldLabel(field: SlotField): string {
  const spaced = field.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Render a slot value (string | number | string[] | null) for chips/tables. */
export function formatSlotValue(value: SlotValue): string {
  if (value === null) return "—";
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
  return String(value);
}
