"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ChatPanel } from "@/components/chat/chat-panel";
import { EmptyState } from "@/components/ui";

/**
 * The pre-WP3 sessionStorage key `session-id.ts` used to persist a per-tab
 * session id. Deleted along with that module — this shim exists ONLY to
 * rescue anyone mid-conversation on deploy day by redirecting them straight
 * to their old session's now-permanent URL, one time, then cleaning up.
 */
const LEGACY_SESSION_STORAGE_KEY = "pebble.chat.sessionId";

/**
 * Chat lobby (Phase C.5 chat overhaul WP3) — `/chat` with no session id yet.
 * Mints a fresh id client-side (so the composer is interactive immediately,
 * no round trip) and renders the exact same `<ChatPanel/>` the conversation
 * route (`/chat/[sessionId]`) renders. On the first message send, `ChatPanel`
 * calls `onFirstMessageSent`, which promotes the URL to `/chat/{id}` via the
 * native History API — NOT `router.replace` — so the in-flight stream isn't
 * lost to a remount (see chat-panel.tsx's `onFirstMessageSent` doc).
 *
 * `?ask=` prefill (from the estimate grid's "Explain" links) is handled
 * inside `ChatPanel` itself and is untouched by any of this.
 */
function LobbyChat() {
  const router = useRouter();
  const [sessionId] = useState(() => crypto.randomUUID());

  // One-time sessionStorage → URL migration shim (see doc above). Runs once
  // on mount; a hit here abandons the freshly-minted id above entirely (no
  // message was ever sent to it) and hands off to the [sessionId] route,
  // which loads the real, persisted conversation.
  useEffect(() => {
    const legacyId = window.sessionStorage.getItem(LEGACY_SESSION_STORAGE_KEY);
    if (!legacyId) return;
    window.sessionStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
    router.replace(`/chat/${legacyId}`);
  }, [router]);

  function onFirstMessageSent() {
    // Shallow URL update — Next.js listens for native History API calls and
    // syncs `usePathname()`/`useSearchParams()` from them without running a
    // navigation, so `ChatPanel` (and the session it's talking to) never
    // remounts. See: https://nextjs.org/docs — "Using the Native History API".
    window.history.replaceState(null, "", `/chat/${sessionId}`);
  }

  return <ChatPanel sessionId={sessionId} onFirstMessageSent={onFirstMessageSent} />;
}

/**
 * `ChatPanel` reads the `?ask=` search param (for the estimate grid's
 * "Explain" links), which requires a Suspense boundary here so `/chat` (no
 * dynamic segment) can still be statically prerendered.
 */
export default function ChatLobbyPage() {
  return (
    <Suspense fallback={<EmptyState>Loading chat…</EmptyState>}>
      <LobbyChat />
    </Suspense>
  );
}
