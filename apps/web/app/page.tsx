"use client";

import Link from "next/link";
import { MarginBadge, SitcBadge } from "@/components/badges";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatINR } from "@/lib/format";
import { trpc } from "@/trpc/react";

function statusTone(status: string): "green" | "amber" | "blue" | "neutral" {
  switch (status) {
    case "APPROVED":
      return "green";
    case "IN_REVIEW":
      return "amber";
    case "DISPATCHED":
      return "blue";
    default:
      return "neutral";
  }
}

export default function DashboardPage() {
  const stats = trpc.dashboard.stats.useQuery();

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Fire-safety estimates from enquiry to approved BOQ."
        actions={
          <Link href="/enquiries/new">
            <Button variant="primary">New enquiry</Button>
          </Link>
        }
      />

      {stats.isLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : stats.isError ? (
        <EmptyState>Failed to load dashboard: {stats.error.message}</EmptyState>
      ) : !stats.data ? (
        <EmptyState>Loading…</EmptyState>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Tile label="Enquiries" value={stats.data.enquiryCount} />
            <Tile label="Estimates" value={stats.data.estimateCount} />
            <Tile label="In review" value={stats.data.byStatus["IN_REVIEW"] ?? 0} />
            <Tile label="Approved" value={stats.data.byStatus["APPROVED"] ?? 0} />
          </div>

          <Card>
            <div className="border-b border-[var(--pebble-border)] px-4 py-3 text-sm font-semibold">
              Recent estimates
            </div>
            {stats.data.recent.length === 0 ? (
              <div className="p-6 text-sm text-[var(--pebble-muted)]">
                No estimates yet. Create an enquiry to generate your first draft.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--pebble-border)] text-left text-xs uppercase tracking-wide text-[var(--pebble-muted)]">
                    <th className="px-4 py-2">Estimate</th>
                    <th className="px-4 py-2">Project</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">SITC</th>
                    <th className="px-4 py-2">Margin</th>
                    <th className="px-4 py-2 text-right tabular">Grand total</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.data.recent.map((e) => (
                    <tr key={e.estimateId} className="border-b border-[var(--pebble-border)] last:border-0">
                      <td className="px-4 py-2">
                        <Link href={`/estimates/${e.estimateId}`} className="font-medium text-[var(--pebble-accent)] hover:underline">
                          {e.estimateId}
                        </Link>
                        <div className="text-xs text-[var(--pebble-muted)]">v{e.currentVersion}</div>
                      </td>
                      <td className="px-4 py-2">
                        <div>{e.projectName}</div>
                        <div className="text-xs text-[var(--pebble-muted)]">{e.clientName}</div>
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                      </td>
                      <td className="px-4 py-2">
                        <SitcBadge status={e.sitcStatus} ratio={null} />
                      </td>
                      <td className="px-4 py-2">
                        <MarginBadge status={e.marginStatus} marginPct={null} requiredAuthority={null} />
                      </td>
                      <td className="px-4 py-2 text-right tabular">
                        {e.grandTotalPaise === null ? "—" : formatINR(e.grandTotalPaise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--pebble-muted)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular">{value}</div>
    </Card>
  );
}
