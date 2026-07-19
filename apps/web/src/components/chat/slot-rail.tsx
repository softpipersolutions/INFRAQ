"use client";

import type { SlotState } from "@pebble/ai";
import { Badge } from "@/components/ui";
import { fieldLabel, SLOT_DISPLAY_ORDER } from "./field-labels";

/**
 * One chip per A.08 slot field (spec §4.4): grey missing, amber proposed,
 * green confirmed. Order + required-ness mirrors @pebble/ai's FIELD_META
 * (see field-labels.ts for why it's duplicated rather than imported).
 */
export function SlotRail({ slotState }: { slotState: SlotState | undefined }) {
  if (!slotState) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {SLOT_DISPLAY_ORDER.map(({ field, required }) => {
        const slot = slotState[field];
        const tone = slot?.status === "confirmed" ? "green" : slot?.status === "proposed" ? "amber" : "neutral";
        const label = fieldLabel(field);
        const title = slot && slot.status !== "missing" ? `${label}: ${slot.value ?? "—"}` : label;
        return (
          <Badge key={field} tone={tone}>
            <span title={title}>
              {label}
              {required ? "" : " (optional)"}
            </span>
          </Badge>
        );
      })}
    </div>
  );
}
