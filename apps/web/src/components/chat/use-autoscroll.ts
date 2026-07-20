"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Distance (px) from the true bottom beyond which the user is considered to
 * have deliberately scrolled away from the live edge of the conversation.
 * Small enough that momentum/rubber-band scrolling on trackpads doesn't
 * falsely "detach", large enough that a couple of lines of headroom don't
 * count as still-attached.
 */
const DETACH_THRESHOLD_PX = 80;

export interface UseAutoscrollResult {
  /** Attach to the scrollable messages container (`overflow-y-auto`). */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Attach to a zero-height sentinel rendered after the last message. */
  endRef: RefObject<HTMLDivElement | null>;
  /** True once the user has scrolled more than the threshold away from the bottom. */
  isDetached: boolean;
  /** Reattach and (smoothly, unless reduced-motion) scroll back to the latest message. */
  jumpToLatest: () => void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Keeps the chat's scroll container stuck to the bottom while messages
 * stream in, unless the user deliberately scrolls up to read earlier context
 * (beyond `DETACH_THRESHOLD_PX` from the bottom) — in which case autoscroll
 * stops until they either scroll back down themselves or call
 * `jumpToLatest`.
 *
 * Two independent mechanisms drive this: a `scroll` listener on the
 * container tracks whether the user is attached, and a `ResizeObserver` on
 * the container's content drives the actual "stick to bottom" scrolling —
 * content grows token-by-token while streaming (not just message-count
 * changes), so watching layout size directly is more robust than re-running
 * an effect off a dependency array. `watch` is an extra, optional signal
 * (e.g. `messages.length` or `status`) that also triggers a re-stick, as a
 * fallback for environments without `ResizeObserver` and to catch the very
 * first paint.
 */
export function useAutoscroll(watch?: unknown): UseAutoscrollResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [isDetached, setIsDetached] = useState(false);
  // Whether we should keep sticking new content to the bottom. A ref (not
  // state) because the scroll/resize listeners need the latest value
  // synchronously without re-subscribing on every change.
  const stickRef = useRef(true);

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    endRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

  // Track user scroll to detect detachment / reattachment.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const detached = distanceFromBottom > DETACH_THRESHOLD_PX;
      stickRef.current = !detached;
      setIsDetached(detached);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Re-stick to the bottom whenever the content grows, as long as the user
  // hasn't detached. Deliberately instant ("auto"), not "smooth": streaming
  // text resizes the content many times a second, and re-triggering a smooth
  // scroll animation on every one of those ticks queues up and stutters —
  // the frequent small instant hops themselves already read as a smooth,
  // continuous follow. "smooth" is reserved for the deliberate, one-shot
  // `jumpToLatest` action below.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) scrollToEnd("auto");
    });
    // Observe the message list itself (the container's first child), not the
    // container — the container has a fixed height, only its content grows.
    const content = el.firstElementChild ?? el;
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToEnd]);

  // Fallback re-stick on the caller's own signal (message count / status),
  // and covers the very first mount before any resize has fired.
  useEffect(() => {
    if (stickRef.current) scrollToEnd("auto");
  }, [watch, scrollToEnd]);

  const jumpToLatest = useCallback(() => {
    stickRef.current = true;
    setIsDetached(false);
    scrollToEnd(prefersReducedMotion() ? "auto" : "smooth");
  }, [scrollToEnd]);

  return { containerRef, endRef, isDetached, jumpToLatest };
}
