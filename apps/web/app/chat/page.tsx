import { Suspense } from "react";
import { ChatPanel } from "@/components/chat/chat-panel";
import { EmptyState, PageHeader } from "@/components/ui";

/**
 * Conversational enquiry capture (spec §4.4) — a UX layer over the same
 * tRPC services the structured enquiry form uses. Slot-filling state lives
 * server-side (chat_sessions.slot_state); this page only renders it and lets
 * the model read/explain/propose, never compute or mutate directly.
 *
 * `/chat` has no dynamic route segment, so Next attempts to statically
 * prerender it — ChatPanel reads the `?ask=` search param (for the estimate
 * grid's "Explain" links), which requires a Suspense boundary here.
 */
export default function ChatPage() {
  return (
    <div>
      <PageHeader
        title="Chat"
        subtitle="Pebble, Greenberg's estimating assistant — capture an enquiry conversationally, or ask about an existing estimate."
      />
      <Suspense fallback={<EmptyState>Loading chat…</EmptyState>}>
        <ChatPanel />
      </Suspense>
    </div>
  );
}
