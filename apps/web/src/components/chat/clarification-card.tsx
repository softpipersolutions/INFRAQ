"use client";

import { MessageCircleQuestion } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import type { ToolPart } from "./tool-activity";

/**
 * A structured-clarification card (Phase C.5 chat overhaul WP6) — the
 * Cowork-style option chips rendered from an `ask_user` tool part.
 *
 * The agent's `ask_user` tool has no executor, so its part never reaches
 * `output-available`: it round-trips as `tool-ask_user` with `state:
 * "input-available"` and the question/options live on `part.input`. This card
 * reads that input defensively (it comes off the wire / out of jsonb).
 *
 * Two modes, decided by the caller:
 *  - INTERACTIVE — when the part is on the LAST message and no later user
 *    message exists yet: the chips are buttons that send the option's label as
 *    the user's next message (via `onPick`).
 *  - STATIC (historical replay) — the chips are inert; if the immediately
 *    following user message text equals one of the labels, that chip is filled
 *    (ink) to show the answer that was chosen.
 */

interface AskUserOption {
  label: string;
  detail?: string;
}

interface AskUserInput {
  question: string;
  options: AskUserOption[];
  allowFreeText: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Defensively parse an `ask_user` part's input; returns null if it isn't a usable clarification. */
export function parseAskUserInput(input: unknown): AskUserInput | null {
  if (!isRecord(input)) return null;
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question) return null;
  const rawOptions = Array.isArray(input.options) ? input.options : [];
  const options: AskUserOption[] = [];
  for (const o of rawOptions) {
    if (!isRecord(o)) continue;
    const label = typeof o.label === "string" ? o.label : "";
    if (!label) continue;
    const detail = typeof o.detail === "string" && o.detail.length > 0 ? o.detail : undefined;
    options.push({ label, detail });
  }
  if (options.length === 0) return null;
  return { question, options, allowFreeText: input.allowFreeText === true };
}

export function ClarificationCard({
  part,
  interactive,
  chosenLabel,
  onPick,
}: {
  part: ToolPart;
  /** True only when this part is on the last message and no later user message exists. */
  interactive: boolean;
  /** Historical replay: the following user message's text, to highlight the chip that was chosen. */
  chosenLabel?: string | null;
  /** Send the chosen option's label as the user's next message. */
  onPick?: (label: string) => void;
}) {
  const parsed = parseAskUserInput(part.input);
  if (!parsed) return null;
  const { question, options, allowFreeText } = parsed;

  return (
    <div className="relative rounded-lg border border-border bg-surface p-3">
      <MessageCircleQuestion
        size={15}
        strokeWidth={1.75}
        className="absolute right-3 top-3 text-ink-muted"
        aria-hidden
      />
      <div className="pr-6 text-sm font-medium text-ink">{question}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((option, i) => {
          const chosen = !interactive && chosenLabel != null && chosenLabel === option.label;
          const base =
            "rounded-full border px-3 py-1.5 text-sm transition";
          const chip = chosen
            ? `${base} border-ink bg-ink text-inverse`
            : interactive
              ? `${base} border-border-strong text-ink hover:bg-ink hover:text-inverse`
              : `${base} border-border-strong text-ink-secondary`;
          const button = (
            <button
              key={i}
              type="button"
              disabled={!interactive}
              onClick={interactive ? () => onPick?.(option.label) : undefined}
              className={`${chip} disabled:cursor-default`}
            >
              {option.label}
            </button>
          );
          return option.detail ? (
            <Tooltip key={i} label={option.detail}>
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
      </div>
      {allowFreeText ? (
        <div className="mt-2 text-xs text-ink-muted">…or just type your answer below</div>
      ) : null}
    </div>
  );
}
