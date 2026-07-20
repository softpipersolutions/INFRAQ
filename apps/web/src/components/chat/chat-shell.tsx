"use client";

import { useState, type ReactNode } from "react";
import { ChatSidebarProvider } from "./chat-sidebar-context";
import { SessionSidebar } from "./session-sidebar";

/**
 * `/chat` route-group shell (Phase C.5 chat overhaul WP3) — renders the
 * session sidebar as a permanent second rail on md+ screens and as a
 * slide-over drawer on mobile (CSS transforms + a click-to-dismiss backdrop,
 * no portal library). Rendered by `app/(app)/chat/layout.tsx`, so it wraps
 * both the lobby (`/chat`) and conversation (`/chat/[sessionId]`) routes —
 * the sidebar itself never remounts across a session switch, only its data
 * (`listSessions`) refetches.
 *
 * `-mx-5 -my-6` cancels the padding `Shell`'s `<main>` applies to every
 * route so the rail can sit flush against it, then the content column
 * re-adds its own padding.
 */
export function ChatShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <ChatSidebarProvider value={{ toggleSidebar: () => setDrawerOpen((v) => !v) }}>
      <div className="-mx-5 -my-6 flex min-h-[calc(100vh-7rem)]">
        <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface md:flex">
          <SessionSidebar />
        </aside>

        <div
          className={`fixed inset-0 z-40 md:hidden ${drawerOpen ? "" : "pointer-events-none"}`}
          aria-hidden={!drawerOpen}
        >
          <div
            className={`absolute inset-0 bg-ink/40 transition-opacity duration-200 ${
              drawerOpen ? "opacity-100" : "opacity-0"
            }`}
            onClick={() => setDrawerOpen(false)}
          />
          <div
            className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-border bg-surface shadow-overlay transition-transform duration-200 ${
              drawerOpen ? "translate-x-0" : "-translate-x-full"
            }`}
          >
            <SessionSidebar onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>

        <div className="min-w-0 flex-1 px-5 py-6">{children}</div>
      </div>
    </ChatSidebarProvider>
  );
}
