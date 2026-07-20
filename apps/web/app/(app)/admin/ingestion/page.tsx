"use client";

import Link from "next/link";
import { STAGED_RECORD_STATUSES, SOURCE_DOC_STATUSES } from "@pebble/shared";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { StatusBadge } from "@/components/ingestion/badges";
import { formatDateTime } from "@/lib/format";
import { trpc } from "@/trpc/react";

/**
 * Corpus dashboard — the admin landing page for Phase B ingestion. Summarises
 * how many of the 145 historical proposals are registered/extracted/staged,
 * and lists every document with a direct link into the verification queue
 * filtered to just that document.
 */
export default function IngestionDashboard() {
  const stats = trpc.ingestion.stats.useQuery();
  const documents = trpc.ingestion.documents.list.useQuery();

  const docs = documents.data ?? [];
  const docsByStatus: Record<string, number> = {};
  for (const d of docs) docsByStatus[d.status] = (docsByStatus[d.status] ?? 0) + 1;

  return (
    <div>
      <PageHeader
        title="Ingestion"
        subtitle="Historical proposal corpus — extraction status, verification queue, RAG chunk coverage."
        actions={
          <Link href="/admin/ingestion/queue">
            <span className="inline-flex items-center rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-inverse hover:bg-grey-800">
              Open verification queue
            </span>
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Tile label="Documents" value={docs.length} />
        <Tile label="Staged (total)" value={stats.data?.total ?? 0} />
        <Tile label="Awaiting review" value={stats.data?.byStatus.PROPOSED ?? 0} tone="warning" />
        <Tile
          label="Committed"
          value={(stats.data?.byStatus.APPROVED ?? 0) + (stats.data?.byStatus.EDITED_APPROVED ?? 0)}
          tone="success"
        />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 text-sm font-semibold">Documents by status</div>
          <dl className="space-y-1.5">
            {SOURCE_DOC_STATUSES.map((s) => (
              <div key={s} className="flex items-center justify-between text-sm">
                <StatusBadge status={s} />
                <span className="tabular font-medium">{docsByStatus[s] ?? 0}</span>
              </div>
            ))}
          </dl>
        </Card>
        <Card className="p-4">
          <div className="mb-3 text-sm font-semibold">Staged records by status</div>
          <dl className="space-y-1.5">
            {STAGED_RECORD_STATUSES.map((s) => (
              <div key={s} className="flex items-center justify-between text-sm">
                <StatusBadge status={s} />
                <span className="tabular font-medium">{stats.data?.byStatus[s] ?? 0}</span>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-2 text-sm font-semibold">
          Documents ({docs.length})
        </div>
        {documents.isLoading ? (
          <div className="p-4 text-sm text-ink-muted">Loading…</div>
        ) : docs.length === 0 ? (
          <EmptyState>
            No source documents registered yet. The worker's ingest pipeline registers each
            historical proposal here as it is processed.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                  <th className="px-3 py-2">Filename</th>
                  <th className="px-3 py-2">File ref</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Staged</th>
                  <th className="px-3 py-2 text-right tabular">Chunks</th>
                  <th className="px-3 py-2">Registered</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => {
                  const staged = STAGED_RECORD_STATUSES.filter((s) => d.stagedCounts[s] > 0);
                  return (
                    <tr key={d.id} className="border-b border-border align-top last:border-0">
                      <td className="px-3 py-2 font-medium">{d.filename}</td>
                      <td className="px-3 py-2 font-mono text-xs">{d.fileRef ?? "—"}</td>
                      <td className="px-3 py-2">
                        <StatusBadge status={d.status} />
                      </td>
                      <td className="px-3 py-2">
                        {staged.length === 0 ? (
                          <span className="text-xs text-ink-muted">none</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {staged.map((s) => (
                              <span
                                key={s}
                                className="rounded border border-border px-1.5 py-0.5 text-xs"
                              >
                                {s} {d.stagedCounts[s]}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular">{d.chunkCount}</td>
                      <td className="px-3 py-2 text-xs text-ink-muted">
                        {formatDateTime(d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/admin/ingestion/queue?doc=${d.id}`}
                          className="text-xs text-ink hover:underline"
                        >
                          Review queue
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Tile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "warning";
}) {
  const toneClass = "text-ink";
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-ink-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular ${toneClass}`}>{value}</div>
    </Card>
  );
}
