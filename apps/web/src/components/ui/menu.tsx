"use client";

import type { LucideIcon } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
}

type TriggerProps = {
  onClick?: (e: MouseEvent) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  "aria-haspopup"?: string;
  "aria-expanded"?: boolean;
};

/**
 * Small headless dropdown (Phase C.5 chat overhaul WP4) — a `trigger` element
 * plus a flat list of `items`. Closes on click-outside, on Escape (returning
 * focus to the trigger), or after an item is selected. Fully keyboard
 * navigable: Arrow Up/Down move between items, Home/End jump to the ends,
 * Enter/Space select. Will grow into the session sidebar's per-session menu
 * (rename/archive/delete) in the next stage.
 */
export function Menu({
  trigger,
  items,
  align = "end",
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.querySelector<HTMLElement>("button, a, [tabindex]")?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  function openMenu(startIndex: number) {
    setActiveIndex(startIndex);
    setOpen(true);
  }

  function onItemKeyDown(e: KeyboardEvent, index: number) {
    if (items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((index + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((index - 1 + items.length) % items.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(items.length - 1);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  const triggerNode = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<TriggerProps>, {
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: (e: MouseEvent) => {
          (trigger as ReactElement<TriggerProps>).props.onClick?.(e);
          setOpen((v) => !v);
          if (!open) setActiveIndex(0);
        },
        onKeyDown: (e: KeyboardEvent) => {
          (trigger as ReactElement<TriggerProps>).props.onKeyDown?.(e);
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            openMenu(0);
          }
        },
      })
    : trigger;

  return (
    <div className="relative inline-block" ref={rootRef}>
      <span ref={triggerRef}>{triggerNode}</span>
      {open ? (
        <div
          role="menu"
          className={`absolute z-50 mt-1 min-w-[10rem] rounded-md border border-border bg-surface py-1 shadow-overlay ${
            align === "end" ? "right-0" : "left-0"
          }`}
        >
          {items.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                onKeyDown={(e) => onItemKeyDown(e, index)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none hover:bg-surface-sunken focus-visible:bg-surface-sunken ${
                  item.danger ? "text-danger" : "text-ink"
                }`}
              >
                {Icon ? <Icon size={14} strokeWidth={1.5} className="shrink-0" aria-hidden /> : null}
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
