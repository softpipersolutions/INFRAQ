"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import type { FieldDelta } from "@pebble/engines";
import type { PricedLine } from "@pebble/shared";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatINR } from "@/lib/format";
import { trpc } from "@/trpc/react";

const MONEY_FIELDS = new Set([
  "supplyRatePaise",
  "installRatePaise",
  "sitcRatePaise",
  "supplyAmountPaise",
  "installAmountPaise",
  "lineAmountPaise",
]);

function fmtValue(field: string, value: number | string | null): string {
  if (value === null) return "—";
  if (MONEY_FIELDS.has(field) && typeof value === "number") return formatINR(value);
  return String(value);
}

export default function ComparePage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const estimateId = params.id;
  const versionA = Number(search.get("a") ?? "1");
  const versionB = Number(search.get("b") ?? "2");

  const cmp = trpc.estimate.compare.useQuery({ estimateId, versionA, versionB });

  return (
    <div>
      <PageHeader
        title="Version compare"
        subtitle={`${estimateId} · v${versionA} → v${versionB}`}
        actions={
          <Link href={`/estimates/${estimateId}`}>
            <Button variant="ghost">Back to estimate</Button>
          </Link>
        }
      />

      {cmp.isLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : cmp.isError ? (
        <EmptyState>Failed to load: {cmp.error.message}</EmptyState>
      ) : !cmp.data ? (
        <EmptyState>Loading…</EmptyState>
      ) : (
        <div className="space-y-4">
          <DiffGroup title="Changed lines" tone="amber" count={cmp.data.diff.changed.length}>
            {cmp.data.diff.changed.map((c) => (
              <div key={c.lineUid} className="px-4 py-3">
                <div className="text-sm font-medium">{c.after.description}</div>
                <div className="text-xs text-[var(--pebble-muted)]">{c.after.materialCode}</div>
                <ul className="mt-2 space-y-1 text-sm">
                  {c.deltas.map((d: FieldDelta) => (
                    <li key={d.field} className="tabular">
                      <span className="font-medium">{d.field}</span>: {fmtValue(d.field, d.before)} →{" "}
                      {fmtValue(d.field, d.after)}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </DiffGroup>

          <DiffGroup title="Added lines" tone="green" count={cmp.data.diff.added.length}>
            {cmp.data.diff.added.map((l: PricedLine) => (
              <LineSummary key={l.lineUid} line={l} />
            ))}
          </DiffGroup>

          <DiffGroup title="Removed lines" tone="red" count={cmp.data.diff.removed.length}>
            {cmp.data.diff.removed.map((l: PricedLine) => (
              <LineSummary key={l.lineUid} line={l} />
            ))}
          </DiffGroup>

          <div className="text-sm text-[var(--pebble-muted)]">
            {cmp.data.diff.unchanged.length} unchanged line
            {cmp.data.diff.unchanged.length === 1 ? "" : "s"}.
          </div>
        </div>
      )}
    </div>
  );
}

function DiffGroup({
  title,
  tone,
  count,
  children,
}: {
  title: string;
  tone: "green" | "red" | "amber";
  count: number;
  children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--pebble-border)] px-4 py-2">
        <span className="text-sm font-semibold">{title}</span>
        <Badge tone={tone}>{count}</Badge>
      </div>
      {count === 0 ? (
        <div className="px-4 py-3 text-sm text-[var(--pebble-muted)]">None.</div>
      ) : (
        <div className="divide-y divide-[var(--pebble-border)]">{children}</div>
      )}
    </Card>
  );
}

function LineSummary({ line }: { line: PricedLine }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div>
        <div className="text-sm font-medium">{line.description}</div>
        <div className="text-xs text-[var(--pebble-muted)]">
          {line.materialCode} · {line.qty} {line.unit}
        </div>
      </div>
      <div className="tabular text-sm font-medium">{formatINR(line.lineAmountPaise)}</div>
    </div>
  );
}
