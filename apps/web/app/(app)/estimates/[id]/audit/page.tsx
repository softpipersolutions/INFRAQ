"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { trpc } from "@/trpc/react";

export default function AuditPage() {
  const params = useParams<{ id: string }>();
  const estimateId = params.id;
  const audit = trpc.estimate.audit.useQuery({ estimateId });

  return (
    <div>
      <PageHeader
        title="Audit timeline"
        subtitle={estimateId}
        actions={
          <Link href={`/estimates/${estimateId}`}>
            <Button variant="ghost">Back to estimate</Button>
          </Link>
        }
      />

      {audit.isLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : audit.isError ? (
        <EmptyState>Failed to load: {audit.error.message}</EmptyState>
      ) : !audit.data ? (
        <EmptyState>Loading…</EmptyState>
      ) : audit.data.length === 0 ? (
        <EmptyState>No audit events.</EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <ol>
            {audit.data.map((e) => (
              <li key={e.id} className="border-b border-border px-4 py-3 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info">{e.eventType}</Badge>
                  {e.version !== null ? <Badge tone="neutral">v{e.version}</Badge> : null}
                  <span className="text-sm text-ink-muted">
                    {e.actor}
                    {e.actorRole ? ` (${e.actorRole})` : ""}
                  </span>
                  <span className="ml-auto text-xs text-ink-muted">{formatDateTime(e.ts)}</span>
                </div>
                <pre className="mt-2 overflow-x-auto rounded bg-surface-sunken p-2 text-xs text-ink-secondary">
                  {summarize(e.payload)}
                </pre>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}

function summarize(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}
