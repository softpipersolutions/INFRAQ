"use client";

import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { trpc } from "@/trpc/react";

const SECTIONS = [
  { href: "/admin/materials", label: "Materials", desc: "A.01 material register" },
  { href: "/admin/makes", label: "Makes & brands", desc: "A.03 approved makes per material" },
  { href: "/admin/prices", label: "Prices", desc: "A.04 buying / selling rates" },
  { href: "/admin/install-rates", label: "Install rates", desc: "A.05 SITC labour rates" },
  { href: "/admin/design-rules", label: "Design rules", desc: "A.06 rule library + dry-run" },
  { href: "/admin/margins", label: "Margin matrix", desc: "A.07 tier margins & authority" },
  { href: "/admin/users", label: "Users & roles", desc: "Sign-in access & role assignment" },
  { href: "/admin/ingestion", label: "Ingestion", desc: "Historical corpus + verification queue" },
];

export default function AdminHome() {
  const snapshot = trpc.masters.snapshot.useQuery();
  const ingestionStats = trpc.ingestion.stats.useQuery();
  const s = snapshot.data;

  return (
    <div>
      <PageHeader title="Masters admin" subtitle="A.01–A.07 master data behind deterministic generation." />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((sec) => (
          <Link key={sec.href} href={sec.href}>
            <Card className="h-full p-4 transition hover:border-[var(--pebble-accent)]">
              <div className="text-sm font-semibold">{sec.label}</div>
              <div className="mt-1 text-xs text-[var(--pebble-muted)]">{sec.desc}</div>
              <div className="mt-3 text-2xl font-semibold tabular">
                {count(sec.href, s, ingestionStats.data) ?? "—"}
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

function count(
  href: string,
  s:
    | {
        materials: unknown[];
        makes: unknown[];
        prices: unknown[];
        installRates: unknown[];
        rules: unknown[];
        marginMatrix: unknown[];
      }
    | undefined,
  ingestion: { total: number; byStatus: Record<string, number> } | undefined,
): number | null {
  // The users section has no snapshot-backed count — render a dash instead.
  if (href === "/admin/users") return null;
  if (href === "/admin/ingestion") return ingestion ? (ingestion.byStatus.PROPOSED ?? 0) : null;
  if (!s) return 0;
  switch (href) {
    case "/admin/materials":
      return s.materials.length;
    case "/admin/makes":
      return s.makes.length;
    case "/admin/prices":
      return s.prices.length;
    case "/admin/install-rates":
      return s.installRates.length;
    case "/admin/design-rules":
      return s.rules.length;
    case "/admin/margins":
      return s.marginMatrix.length;
    default:
      return 0;
  }
}
