import type { ReactNode } from "react";
import { ChatShell } from "@/components/chat/chat-shell";

/**
 * Wraps both the chat lobby (`/chat`) and conversation (`/chat/[sessionId]`)
 * routes in the session sidebar (Phase C.5 chat overhaul WP3) — a persistent
 * second rail on md+ screens, a slide-over drawer on mobile. Nested inside
 * `app/(app)/layout.tsx`'s `Shell`, so this only ever needs to add the
 * chat-specific chrome; auth/nav/tRPC are already provided above it.
 */
export default function ChatLayout({ children }: { children: ReactNode }) {
  return <ChatShell>{children}</ChatShell>;
}
