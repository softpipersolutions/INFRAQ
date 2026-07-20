"use client";

import type { SlotState } from "@pebble/ai";
import { Button, Card } from "@/components/ui";
import { fieldLabel, formatSlotValue, SLOT_DISPLAY_ORDER } from "./field-labels";

/**
 * Shown once every required slot is proposed/confirmed (chat.sessionState
 * readyToConfirm). Summarises the proposed A.08 record and hands off to
 * chat.confirmEnquiry — the same enquiry.create path the structured form uses.
 */
export function ConfirmationCard({
  slotState,
  onConfirm,
  pending,
  error,
}: {
  slotState: SlotState;
  onConfirm: () => void;
  pending: boolean;
  error: string | null;
}) {
  const rows = SLOT_DISPLAY_ORDER.filter(({ field }) => {
    const slot = slotState[field];
    return slot && slot.value !== null && slot.value !== "";
  });

  return (
    <Card className="p-4">
      <div className="mb-1 text-sm font-semibold">Prefer a button?</div>
      <p className="mb-3 text-sm text-ink-muted">
        Review the captured details and confirm here — or just tell Pebble to go ahead in the chat.
      </p>
      <table className="w-full text-sm">
        <tbody>
          {rows.map(({ field }) => {
            const slot = slotState[field];
            return (
              <tr key={field} className="border-b border-border last:border-0">
                <td className="py-1.5 pr-4 align-top font-medium text-ink-muted">
                  {fieldLabel(field)}
                </td>
                <td className="py-1.5">{formatSlotValue(slot!.value)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error ? <div className="mt-3 text-sm text-danger">{error}</div> : null}
      <div className="mt-3">
        <Button variant="primary" disabled={pending} onClick={onConfirm}>
          {pending ? "Creating…" : "Create enquiry & generate"}
        </Button>
      </div>
    </Card>
  );
}
