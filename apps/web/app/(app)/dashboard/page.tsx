"use client";

import Link from "next/link";
import { MarginBadge, SitcBadge } from "@/components/badges";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatINR } from "@/lib/format";
import { trpc } from "@/trpc/react";

function statusTone(status: string): "success" | "warning" | "info" | "neutral" {
  switch (status) {
    case "APPROVED":
      return "success";
    case "IN_REVIEW":
      return "warning";
    case "DISPATCHED":
      return "info";
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

      <GettingStarted />

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

          <div className="mb-6">
            <LlmCostTile />
          </div>

          <Card>
            <div className="border-b border-border px-4 py-3 text-sm font-semibold">
              Recent estimates
            </div>
            {stats.data.recent.length === 0 ? (
              <div className="p-6 text-sm text-ink-muted">
                No estimates yet. Create an enquiry to generate your first draft.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
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
                    <tr key={e.estimateId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 tabular">
                        <Link href={`/estimates/${e.estimateId}`} className="font-medium text-ink hover:underline">
                          {e.estimateId}
                        </Link>
                        <div className="text-xs text-ink-muted">v{e.currentVersion}</div>
                      </td>
                      <td className="px-4 py-2">
                        <div>{e.projectName}</div>
                        <div className="text-xs text-ink-muted">{e.clientName}</div>
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

/** Static orientation card — the three ways into the workflow. */
function GettingStarted() {
  return (
    <Card className="mb-6 p-4">
      <div className="text-sm font-semibold text-ink">Getting started</div>
      <ul className="mt-2 space-y-1.5 text-sm text-ink-secondary">
        <li>
          Start in{" "}
          <Link href="/chat" className="font-medium text-ink hover:underline">
            Chat
          </Link>{" "}
          to describe an enquiry in plain language.
        </li>
        <li>
          Prefer forms?{" "}
          <Link href="/enquiries/new" className="font-medium text-ink hover:underline">
            New Enquiry
          </Link>{" "}
          captures the same fields.
        </li>
        <li>
          Every estimate lives in{" "}
          <Link href="/history" className="font-medium text-ink hover:underline">
            History
          </Link>{" "}
          with its full audit trail.
        </li>
      </ul>
    </Card>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular">{value}</div>
    </Card>
  );
}

/** Compact token-count formatting for the cache line ("120k", "8k", "340" — no decimals below 1k). */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

/**
 * LLM spend tile (spec §4.4 cost dashboard): today's spend + call count from
 * dashboard.llmCost (works standalone), layered with today's daily budget
 * from chat.costToday when that router is available. The chat router is
 * owned by a parallel lane — the budget query is allowed to fail (retry
 * disabled) and is simply omitted from the tile until it lands.
 *
 * WP10: a small secondary line under the spend surfaces today's cache
 * read/write token totals (`llm_calls.cache_read_tokens`/`cache_write_tokens`,
 * columns since WP1) — a live "is prompt caching actually landing" signal.
 * Omitted entirely when today has no cache activity yet (e.g. a fresh env or
 * before the first Claude turn), so the tile never shows a misleading "0
 * read · 0 written" on day one.
 */
function LlmCostTile() {
  const cost = trpc.dashboard.llmCost.useQuery();
  const budget = trpc.chat.costToday.useQuery(undefined, { retry: false });
  const budgetUsd = !budget.isError ? (budget.data?.budgetUsd ?? null) : null;

  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-ink-muted">AI spend today</div>
      {cost.isLoading || !cost.data ? (
        <div className="mt-1 text-sm text-ink-muted">Loading…</div>
      ) : cost.isError ? (
        <div className="mt-1 text-sm text-danger">Failed to load: {cost.error.message}</div>
      ) : (
        <>
          <div className="mt-1 text-2xl font-semibold tabular">${cost.data.today.costUsd.toFixed(4)}</div>
          <div className="mt-1 text-xs text-ink-muted">
            {cost.data.today.calls} call{cost.data.today.calls === 1 ? "" : "s"}
            {budgetUsd !== null ? ` · budget $${budgetUsd.toFixed(2)}` : ""}
            {" · "}${cost.data.month.costUsd.toFixed(2)} this month ({cost.data.month.calls} calls)
          </div>
          {cost.data.today.cacheReadTokens > 0 || cost.data.today.cacheWriteTokens > 0 ? (
            <div className="mt-0.5 text-xs text-ink-muted">
              cache: {formatTokenCount(cost.data.today.cacheReadTokens)} read ·{" "}
              {formatTokenCount(cost.data.today.cacheWriteTokens)} written today
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
