"use client";

import type { SlotState } from "@pebble/ai";
import { CheckCircle2, CircleDashed, CircleDot, type LucideIcon } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { fieldLabel, SLOT_DISPLAY_ORDER } from "./field-labels";

/** Slot-rail-specific chip treatment — distinct from the generic Badge tones. */
const CHIP_STYLES = {
  confirmed: "bg-ink text-inverse",
  proposed: "border border-border-strong text-ink",
  missing: "border border-dashed border-border-strong text-ink-muted",
} as const;

/** Status glyph per chip: dashed outline missing, half-filled proposed, solid check confirmed. */
const STATUS_ICON: Record<keyof typeof CHIP_STYLES, LucideIcon> = {
  missing: CircleDashed,
  proposed: CircleDot,
  confirmed: CheckCircle2,
};

const STATUS_NAME: Record<keyof typeof CHIP_STYLES, string> = {
  missing: "Missing",
  proposed: "Proposed — not yet confirmed",
  confirmed: "Confirmed",
};

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
        const Icon = STATUS_ICON[status];
        const tooltipLabel =
          slot && slot.status !== "missing"
            ? `${STATUS_NAME[status]} — ${label}: ${slot.value ?? "—"}`
            : `${STATUS_NAME[status]} — ${label}`;
        return (
          <Tooltip key={field} label={tooltipLabel}>
            <span
              tabIndex={0}
              className={`inline-flex max-w-[10rem] items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${CHIP_STYLES[status]}`}
            >
              <Icon size={12} strokeWidth={1.5} className="shrink-0" aria-hidden />
              <span className="truncate">
                {label}
                {required ? "" : " (optional)"}
              </span>
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
