"use client";

import type { ReactNode } from "react";

/**
 * CSS-only tooltip (Phase C.5 chat overhaul WP4). No JS state — it never
 * fights a trigger's own click handlers or focus management, and it works
 * for both mouse and keyboard users out of the box: reveals on hover
 * (`group-hover`) or when the trigger is keyboard-focused
 * (`group-has-[:focus-visible]`), after a short delay so it doesn't flash
 * while the pointer passes over a row of icons. `prefers-reduced-motion`
 * users get an instant show/hide instead of a fade.
 *
 * The trigger must be a single element that can take hover/focus (an icon
 * button, a truncated label, etc.) — `Tooltip` wraps it in an inline span,
 * it doesn't clone or modify it.
 */
export function Tooltip({
  label,
  children,
  position = "top",
}: {
  label: string;
  children: ReactNode;
  position?: "top" | "bottom";
}) {
  const placement =
    position === "top"
      ? "bottom-full left-1/2 mb-1.5 -translate-x-1/2"
      : "top-full left-1/2 mt-1.5 -translate-x-1/2";

  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute ${placement} z-50 w-max max-w-[16rem] rounded bg-ink px-2 py-1 text-xs text-inverse opacity-0 shadow-overlay transition-opacity delay-300 duration-150 group-hover/tooltip:opacity-100 group-has-[:focus-visible]/tooltip:opacity-100 motion-reduce:delay-0 motion-reduce:transition-none`}
      >
        {label}
      </span>
    </span>
  );
}
