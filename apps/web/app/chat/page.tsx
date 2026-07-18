import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";

/**
 * Chat is a later-phase UX layer over the same tRPC services the enquiry form
 * uses (spec §4.4 slot-filling). It is intentionally a stub here — the core
 * enquiry → draft → review → approve loop runs entirely through the structured
 * screens with zero AI, which is the acceptance gate for this build.
 */
export default function ChatPage() {
  return (
    <div>
      <PageHeader title="Chat" subtitle="Conversational enquiry capture — later phase." />
      <Card className="p-6 text-sm text-[var(--pebble-muted)]">
        <p className="mb-3">
          The conversational lane (Gemini retrieval + Claude drafting with slot-filling from
          <code className="mx-1 rounded bg-slate-100 px-1">@pebble/ai</code>) will capture an enquiry
          in natural language, confirm the A.08 record, and then call the same
          <code className="mx-1 rounded bg-slate-100 px-1">enquiry.create</code> service the form uses
          to generate a draft.
        </p>
        <p>
          For now, use the{" "}
          <Link href="/enquiries/new" className="text-[var(--pebble-accent)] hover:underline">
            structured enquiry form
          </Link>{" "}
          — it exercises the full deterministic generation path.
        </p>
      </Card>
    </div>
  );
}
