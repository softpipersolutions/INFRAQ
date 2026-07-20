"use client";

import type { SlotState } from "@pebble/ai";
import { fieldLabel, SLOT_DISPLAY_ORDER } from "./field-labels";

/** Slot-rail-specific chip treatment — distinct from the generic Badge tones. */
const CHIP_STYLES = {
  confirmed: "bg-ink text-inverse",
  proposed: "border border-border-strong text-ink",
  missing: "border border-dashed border-border-strong text-ink-muted",
} as const;

/**
 * One chip per A.08 slot field (spec §4.4): dashed grey outline missing, grey
 * outline proposed, solid ink confirmed. Order + required-ness mirrors
 * @pebble/ai's FIELD_META (see field-labels.ts for why it's duplicated
 * rather than imported).
 */
export function SlotRail({ slotState }: { slotState: SlotState | undefined }) {
  if (!slotState) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {SLOT_DISPLAY_ORDER.map(({ field, required }) => {
        const slot = slotState[field];
        const status = slot?.status === "confirmed" ? "confirmed" : slot?.status === "proposed" ? "proposed" : "missing";
        const label = fieldLabel(field);
        const title = slot && slot.status !== "missing" ? `${label}: ${slot.value ?? "—"}` : label;
        return (
          <span
            key={field}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${CHIP_STYLES[status]}`}
          >
            <span title={title}>
              {label}
              {required ? "" : " (optional)"}
            </span>
          </span>
        );
      })}
    </div>
  );
}
