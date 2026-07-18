"use client";

import { useState } from "react";
import { Badge, Button, Card, TextInput } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { trpc } from "@/trpc/react";

/**
 * Documents panel for the estimate page: generate the Format A PDF + Excel via
 * the worker (LOCKED versions only — the worker's 400 guard is surfaced
 * verbatim otherwise), list the rendered artifacts with download links, and —
 * for approvers/admins — dispatch them to the client over email/WhatsApp with
 * the enquiry's contact details prefilled. All money on the documents comes
 * from persisted version totals; nothing is recomputed client-side.
 */

interface DispatchOutcome {
  channel: string;
  status: string;
  provider: string;
  providerMessageId: string | null;
  error: string | null;
}

function statusTone(status: string): "green" | "amber" | "red" | "neutral" {
  if (status === "SENT" || status === "DELIVERED") return "green";
  if (status === "QUEUED") return "amber";
  if (status === "FAILED") return "red";
  return "neutral";
}

export function DocumentsPanel({
  estimateId,
  versionState,
  clientEmail,
  clientPhone,
}: {
  estimateId: string;
  /** State of the estimate's current version — rendering requires LOCKED. */
  versionState: "WORKING" | "LOCKED";
  clientEmail: string | null;
  clientPhone: string | null;
}) {
  const utils = trpc.useUtils();
  const me = trpc.users.me.useQuery();
  const documents = trpc.estimate.documents.useQuery({ estimateId });
  const dispatches = trpc.estimate.dispatches.useQuery({ estimateId });

  const [renderMsg, setRenderMsg] = useState<string | null>(null);
  const render = trpc.estimate.render.useMutation({
    onSuccess: () => {
      setRenderMsg(null);
      void utils.estimate.documents.invalidate({ estimateId });
    },
    onError: (err) => setRenderMsg(err.message),
  });

  const role = me.data?.user?.role;
  const canDispatch = role === "approver" || role === "admin";
  const locked = versionState === "LOCKED";
  const hasDocuments = (documents.data?.length ?? 0) > 0;

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold">Documents</span>
        <Button
          variant="primary"
          disabled={!locked || render.isPending}
          onClick={() => render.mutate({ estimateId })}
        >
          {render.isPending ? "Generating…" : "Generate PDF + Excel"}
        </Button>
        {!locked ? (
          <span className="text-sm text-[var(--pebble-muted)]">
            Current version is WORKING — approve (lock) it before generating documents.
          </span>
        ) : null}
        {renderMsg ? <span className="text-sm text-red-700">{renderMsg}</span> : null}
      </div>

      {documents.isLoading ? (
        <div className="text-sm text-[var(--pebble-muted)]">Loading documents…</div>
      ) : !hasDocuments ? (
        <div className="text-sm text-[var(--pebble-muted)]">No documents generated yet.</div>
      ) : (
        <ul className="mb-1 divide-y divide-[var(--pebble-border)]">
          {documents.data!.map((doc) => (
            <li key={doc.id} className="flex flex-wrap items-center gap-3 py-2">
              <Badge tone={doc.docType === "PDF" ? "red" : "green"}>{doc.docType}</Badge>
              <Badge tone="neutral">v{doc.versionNo}</Badge>
              <a
                href={`/api/documents/${doc.id}`}
                className="text-sm font-medium text-[var(--pebble-accent)] hover:underline"
              >
                Download
              </a>
              <span className="font-mono text-xs text-[var(--pebble-muted)]" title={doc.sha256}>
                sha256 {doc.sha256.slice(0, 12)}…
              </span>
              <span className="ml-auto text-xs text-[var(--pebble-muted)]">
                {formatDateTime(doc.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canDispatch ? (
        <SendSection
          estimateId={estimateId}
          hasDocuments={hasDocuments}
          clientEmail={clientEmail}
          clientPhone={clientPhone}
        />
      ) : null}

      <div className="mt-4 border-t border-[var(--pebble-border)] pt-3">
        <div className="mb-2 text-sm font-semibold">Dispatch history</div>
        {dispatches.isLoading ? (
          <div className="text-sm text-[var(--pebble-muted)]">Loading…</div>
        ) : (dispatches.data?.length ?? 0) === 0 ? (
          <div className="text-sm text-[var(--pebble-muted)]">Nothing sent yet.</div>
        ) : (
          <ul className="divide-y divide-[var(--pebble-border)]">
            {dispatches.data!.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
                <Badge tone="blue">{d.channel}</Badge>
                <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                <span className="text-sm">{d.recipient}</span>
                <span className="text-xs text-[var(--pebble-muted)]">
                  {d.provider}
                  {d.providerMessageId ? ` · ${d.providerMessageId}` : ""}
                </span>
                {d.error ? <span className="text-xs text-red-700">{d.error}</span> : null}
                <span className="ml-auto text-xs text-[var(--pebble-muted)]">
                  {formatDateTime(d.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function SendSection({
  estimateId,
  hasDocuments,
  clientEmail,
  clientPhone,
}: {
  estimateId: string;
  hasDocuments: boolean;
  clientEmail: string | null;
  clientPhone: string | null;
}) {
  const utils = trpc.useUtils();
  const [emailOn, setEmailOn] = useState(true);
  const [whatsappOn, setWhatsappOn] = useState(false);
  const [email, setEmail] = useState(clientEmail ?? "");
  const [phone, setPhone] = useState(clientPhone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<DispatchOutcome[] | null>(null);

  const dispatchDocs = trpc.estimate.dispatchDocs.useMutation({
    onSuccess: (results) => {
      setError(null);
      setOutcomes(results);
      void utils.estimate.dispatches.invalidate({ estimateId });
    },
    onError: (err) => {
      setOutcomes(null);
      setError(err.message);
    },
  });

  function onSend() {
    setError(null);
    const channels: ("email" | "whatsapp")[] = [
      ...(emailOn ? (["email"] as const) : []),
      ...(whatsappOn ? (["whatsapp"] as const) : []),
    ];
    if (channels.length === 0) {
      setError("Pick at least one channel.");
      return;
    }
    if (emailOn && email.trim() === "") {
      setError("Email channel selected — enter a recipient email.");
      return;
    }
    if (whatsappOn && phone.trim() === "") {
      setError("WhatsApp channel selected — enter a recipient phone.");
      return;
    }
    dispatchDocs.mutate({
      estimateId,
      channels,
      recipientEmail: emailOn ? email.trim() : undefined,
      recipientPhone: whatsappOn ? phone.trim() : undefined,
    });
  }

  return (
    <div className="mt-4 border-t border-[var(--pebble-border)] pt-3">
      <div className="mb-2 text-sm font-semibold">Send to client</div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex items-start gap-2">
          <input
            id="channel-email"
            type="checkbox"
            className="mt-2"
            checked={emailOn}
            onChange={(e) => setEmailOn(e.target.checked)}
          />
          <label htmlFor="channel-email" className="flex-1 text-sm">
            <span className="mb-1 block font-medium">Email</span>
            <TextInput
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="client@example.com"
              disabled={!emailOn}
            />
          </label>
        </div>
        <div className="flex items-start gap-2">
          <input
            id="channel-whatsapp"
            type="checkbox"
            className="mt-2"
            checked={whatsappOn}
            onChange={(e) => setWhatsappOn(e.target.checked)}
          />
          <label htmlFor="channel-whatsapp" className="flex-1 text-sm">
            <span className="mb-1 block font-medium">WhatsApp</span>
            <TextInput
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91XXXXXXXXXX"
              disabled={!whatsappOn}
            />
          </label>
        </div>
      </div>
      {!hasDocuments ? (
        <div className="mt-2 text-sm text-[var(--pebble-muted)]">
          Generate documents first — the dispatch attaches the latest PDF + Excel.
        </div>
      ) : null}
      {error ? <div className="mt-2 text-sm text-red-700">{error}</div> : null}
      {outcomes ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {outcomes.map((o) => (
            <Badge key={o.channel} tone={statusTone(o.status)}>
              {o.channel} {o.status}
              {o.error ? ` — ${o.error}` : ""}
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="mt-3">
        <Button
          variant="primary"
          disabled={dispatchDocs.isPending || !hasDocuments}
          onClick={onSend}
        >
          {dispatchDocs.isPending ? "Sending…" : "Send to client"}
        </Button>
      </div>
    </div>
  );
}
