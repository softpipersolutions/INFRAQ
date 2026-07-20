"use client";

import { createContext, useContext } from "react";

/**
 * Shares the mobile session-drawer's open/toggle state between `ChatShell`
 * (the `/chat` layout, which owns the drawer + backdrop) and `ChatPanel`
 * (which renders the PanelLeft toggle button in its slim conversation
 * header) — they're siblings under the layout, not parent/child, so a plain
 * prop can't cross that boundary. Phase C.5 chat overhaul WP3.
 */
export interface ChatSidebarContextValue {
  toggleSidebar: () => void;
}

const ChatSidebarContext = createContext<ChatSidebarContextValue | null>(null);

export const ChatSidebarProvider = ChatSidebarContext.Provider;

/** No-op fallback outside `ChatShell` so callers never have to null-check. */
export function useChatSidebarToggle(): () => void {
  const ctx = useContext(ChatSidebarContext);
  return ctx?.toggleSidebar ?? (() => {});
}
