"use client";

import { ChevronDown, ChevronRight, MoreHorizontal, ShieldX, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, EmptyState, PageHeader, TextInput } from "@/components/ui";
import { Menu } from "@/components/ui/menu";
import { formatDateTime } from "@/lib/format";
import { trpc } from "@/trpc/react";

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3m ago" / "2h ago" / "5d ago"-style label, always relative to now. */
function relativeTime(iso: string): string {
  const diffMin = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (Math.abs(diffMin) < 60) return relativeTimeFormatter.format(diffMin, "minute");
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) return relativeTimeFormatter.format(diffHour, "hour");
  const diffDay = Math.round(diffHour / 24);
  if (Math.abs(diffDay) < 30) return relativeTimeFormatter.format(diffDay, "day");
  return relativeTimeFormatter.format(Math.round(diffDay / 30), "month");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Admin → Access (in-app allowlist management). Pending sign-in requests can be
 * approved (adds the email to the DB allowlist + stamps APPROVED — the person
 * signs in again with no redeploy) or denied. The DB-managed allowlist is edited
 * inline, and the deploy-baked env allowlist is shown read-only for reference.
 */
export default function AccessPage() {
  const utils = trpc.useUtils();
  const pending = trpc.access.requests.useQuery({ status: "PENDING" });
  const denied = trpc.access.requests.useQuery({ status: "DENIED" });
  const allowed = trpc.access.allowed.useQuery();
  const envConfig = trpc.access.envConfig.useQuery();

  const [showDenied, setShowDenied] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addNote, setAddNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    await Promise.all([
      utils.access.requests.invalidate(),
      utils.access.pendingCount.invalidate(),
      utils.access.allowed.invalidate(),
    ]);
  }

  const approve = trpc.access.approve.useMutation({
    onSuccess: async () => {
      setMsg("Approved — the account can sign in again now.");
      await refresh();
    },
    onError: (e) => setMsg(e.message),
  });
  const deny = trpc.access.deny.useMutation({
    onSuccess: async () => {
      setMsg("Request denied.");
      await refresh();
    },
    onError: (e) => setMsg(e.message),
  });
  const setActive = trpc.access.setActive.useMutation({
    onSuccess: async () => {
      await refresh();
    },
    onError: (e) => setMsg(e.message),
  });
  const add = trpc.access.addEmail.useMutation({
    onSuccess: async () => {
      setMsg(`Added ${addEmail.trim().toLowerCase()} to the allowlist.`);
      setAddEmail("");
      setAddNote("");
      await refresh();
    },
    onError: (e) => setMsg(e.message),
  });

  const busy = approve.isPending || deny.isPending || setActive.isPending || add.isPending;
  const addValid = EMAIL_RE.test(addEmail.trim());

  function onAdd() {
    if (!addValid) {
      setMsg("Enter a valid email address.");
      return;
    }
    setMsg(null);
    add.mutate({ email: addEmail.trim(), note: addNote.trim() || undefined });
  }

  const pendingRows = pending.data ?? [];
  const deniedRows = denied.data ?? [];
  const allowedRows = allowed.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Access"
        subtitle="Approve new Google sign-ins and manage the allowlist — no redeploy needed."
        actions={msg ? <span className="text-xs text-ink-muted">{msg}</span> : undefined}
      />

      {/* Pending requests */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-2 text-sm font-semibold">
          Pending requests ({pendingRows.length})
        </div>
        {pending.isLoading ? (
          <div className="px-4 py-6 text-sm text-ink-muted">Loading…</div>
        ) : pendingRows.length === 0 ? (
          <div className="p-4">
            <EmptyState>No pending requests.</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Attempts</th>
                  <th className="px-3 py-2">Last attempt</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {pendingRows.map((r) => (
                  <tr key={r.email} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{r.email}</td>
                    <td className="px-3 py-2">{r.displayName ?? "—"}</td>
                    <td className="px-3 py-2 tabular">{r.attemptCount}</td>
                    <td className="px-3 py-2 text-ink-muted" title={formatDateTime(r.lastSeen)}>
                      {relativeTime(r.lastSeen)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="primary"
                          disabled={busy}
                          onClick={() => approve.mutate({ email: r.email })}
                        >
                          Approve
                        </Button>
                        <Button variant="ghost" disabled={busy} onClick={() => deny.mutate({ email: r.email })}>
                          Deny
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Denied — collapsed; a rejected address can still be approved later. */}
        {deniedRows.length > 0 ? (
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setShowDenied((v) => !v)}
              className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs font-medium text-ink-muted hover:text-ink"
            >
              {showDenied ? (
                <ChevronDown size={14} strokeWidth={1.5} aria-hidden />
              ) : (
                <ChevronRight size={14} strokeWidth={1.5} aria-hidden />
              )}
              Denied ({deniedRows.length})
            </button>
            {showDenied ? (
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full text-sm">
                  <tbody>
                    {deniedRows.map((r) => (
                      <tr key={r.email} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{r.email}</td>
                        <td className="px-3 py-2">{r.displayName ?? "—"}</td>
                        <td className="px-3 py-2 tabular">{r.attemptCount}</td>
                        <td className="px-3 py-2 text-ink-muted" title={formatDateTime(r.lastSeen)}>
                          {relativeTime(r.lastSeen)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            variant="primary"
                            disabled={busy}
                            onClick={() => approve.mutate({ email: r.email })}
                          >
                            Approve
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* Allowed emails (DB-managed) */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-2 text-sm font-semibold">
          Allowed emails ({allowedRows.length})
        </div>

        {/* Manual add form */}
        <div className="flex flex-wrap items-end gap-2 border-b border-border px-4 py-3">
          <div className="min-w-[16rem] flex-1">
            <span className="mb-1 block text-xs font-medium text-ink-muted">Add email</span>
            <TextInput
              type="email"
              placeholder="name@company.com"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
            />
          </div>
          <div className="min-w-[12rem] flex-1">
            <span className="mb-1 block text-xs font-medium text-ink-muted">Note (optional)</span>
            <TextInput
              placeholder="e.g. new estimator"
              value={addNote}
              onChange={(e) => setAddNote(e.target.value)}
            />
          </div>
          <Button variant="primary" disabled={!addValid || busy} onClick={onAdd}>
            Add
          </Button>
        </div>

        {allowed.isLoading ? (
          <div className="px-4 py-6 text-sm text-ink-muted">Loading…</div>
        ) : allowedRows.length === 0 ? (
          <div className="p-4">
            <EmptyState>No emails added here yet. Approve a request or add one above.</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Added by</th>
                  <th className="px-3 py-2">Added</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {allowedRows.map((r) => (
                  <tr key={r.email} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.email}
                      {r.note ? <div className="mt-0.5 text-ink-muted">{r.note}</div> : null}
                    </td>
                    <td className="px-3 py-2 text-ink-secondary">{r.addedBy}</td>
                    <td className="px-3 py-2 text-ink-muted">{formatDateTime(r.createdAt)}</td>
                    <td className="px-3 py-2">
                      <Badge tone={r.active ? "success" : "neutral"}>{r.active ? "active" : "inactive"}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Menu
                        trigger={
                          <button
                            type="button"
                            className="inline-flex items-center rounded-md p-1.5 text-ink-muted hover:bg-grey-100 hover:text-ink"
                            aria-label={`Actions for ${r.email}`}
                          >
                            <MoreHorizontal size={16} strokeWidth={1.5} aria-hidden />
                          </button>
                        }
                        items={[
                          r.active
                            ? {
                                label: "Deactivate",
                                icon: ShieldX,
                                danger: true,
                                onSelect: () => setActive.mutate({ email: r.email, active: false }),
                              }
                            : {
                                label: "Reactivate",
                                icon: ShieldCheck,
                                onSelect: () => setActive.mutate({ email: r.email, active: true }),
                              },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Env-configured base allowlist (read-only) */}
      <Card className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">Base allowlist</span>
          <Badge tone="info">configured at deploy</Badge>
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          Set via PEBBLE_ALLOWED_EMAILS / PEBBLE_ALLOWED_DOMAIN. These always grant access and can
          only change with a redeploy.
        </p>
        <div className="mt-3 space-y-1 text-sm">
          {envConfig.data?.domain ? (
            <div>
              <span className="text-ink-muted">Domain:</span>{" "}
              <span className="font-mono text-xs">@{envConfig.data.domain}</span>
            </div>
          ) : null}
          {(envConfig.data?.emails.length ?? 0) > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {envConfig.data?.emails.map((e) => (
                <span key={e} className="rounded border border-border px-2 py-0.5 font-mono text-xs text-ink-secondary">
                  {e}
                </span>
              ))}
            </div>
          ) : null}
          {!envConfig.data?.domain && (envConfig.data?.emails.length ?? 0) === 0 ? (
            <p className="text-ink-muted">
              None configured — access is governed entirely by the allowlist above.
            </p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
