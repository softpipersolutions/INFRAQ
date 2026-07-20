"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { ChatPanel } from "@/components/chat/chat-panel";

/** Loose UUID-ish check — just enough to reject obvious garbage before it ever reaches the backend (which would otherwise just 404 it as NOT_FOUND anyway). */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A conversation route (Phase C.5 chat overhaul WP3) — `/chat/{sessionId}`.
 * Client component reading the dynamic segment via `useParams` (matches the
 * existing `/estimates/[id]` pattern in this app), rendering the exact same
 * `<ChatPanel/>` the lobby (`/chat`) renders — switching sessions is handled
 * entirely by `ChatPanel`'s `useChat({ id: sessionId })`, not by remounting
 * this page.
 */
export default function ChatSessionPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  if (!UUID_LIKE.test(sessionId)) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-ink-muted">
        This conversation link looks invalid.{" "}
        <Link href="/chat" className="underline">
          Start a new chat
        </Link>
        .
      </div>
    );
  }

  return <ChatPanel sessionId={sessionId} />;
}
