"use client";

import { useState } from "react";
import { DISCOUNT_AUTHORITIES, marginRowSchema } from "@pebble/shared";
import { Badge, Button, Card, Field, PageHeader, Select, TextInput } from "@/components/ui";
import { trpc } from "@/trpc/react";

export default function MarginsPage() {
  const snapshot = trpc.masters.snapshot.useQuery();
  const utils = trpc.useUtils();
  const create = trpc.masters.createMarginRow.useMutation();

  const [tier, setTier] = useState("1");
  const [tierLabel, setTierLabel] = useState("");
  const [target, setTarget] = useState("");
  const [floor, setFloor] = useState("");
  const [authority, setAuthority] = useState<string>("Self");
  const [msg, setMsg] = useState<string | null>(null);

  const rows = (snapshot.data?.marginMatrix ?? []).slice().sort((a, b) => a.tier - b.tier);

  async function onCreate() {
    setMsg(null);
    const parsed = marginRowSchema.safeParse({
      tier: Number(tier),
      tierLabel,
      targetMarginPct: Number(target),
      floorMarginPct: Number(floor),
      discountAuthority: authority,
    });
    if (!parsed.success) {
      setMsg(parsed.error.issues.map((i) => i.message).join(", "));
      return;
    }
    try {
      await create.mutateAsync(parsed.data);
      setMsg("Margin tier saved.");
      await utils.masters.snapshot.invalidate();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Save failed (tier may already exist)");
    }
  }

  return (
    <div>
      <PageHeader title="Margin matrix (A.07)" subtitle="Tier target / floor margin and the discount authority below floor." />
      <Card className="mb-6 p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
          <Field label="Tier (1–4)">
            <Select value={tier} onChange={(e) => setTier(e.target.value)}>
              {[1, 2, 3, 4].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Label">
            <TextInput value={tierLabel} onChange={(e) => setTierLabel(e.target.value)} placeholder="₹5L–20L" />
          </Field>
          <Field label="Target %">
            <TextInput type="number" min={0} max={100} value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <Field label="Floor %">
            <TextInput type="number" min={0} max={100} value={floor} onChange={(e) => setFloor(e.target.value)} />
          </Field>
          <Field label="Authority">
            <Select value={authority} onChange={(e) => setAuthority(e.target.value)}>
              {DISCOUNT_AUTHORITIES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" disabled={create.isPending} onClick={onCreate}>
            {create.isPending ? "Saving…" : "Save tier"}
          </Button>
          {msg ? <span className="text-sm text-ink-muted">{msg}</span> : null}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-2 text-sm font-semibold">Tiers ({rows.length})</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-3 py-2">Tier</th>
              <th className="px-3 py-2">Label</th>
              <th className="px-3 py-2 text-right tabular">Target %</th>
              <th className="px-3 py-2 text-right tabular">Floor %</th>
              <th className="px-3 py-2">Authority</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tier} className="border-b border-border last:border-0">
                <td className="px-3 py-2 tabular font-medium">T{r.tier}</td>
                <td className="px-3 py-2">{r.tierLabel}</td>
                <td className="px-3 py-2 text-right tabular">{r.targetMarginPct}</td>
                <td className="px-3 py-2 text-right tabular">{r.floorMarginPct}</td>
                <td className="px-3 py-2">
                  <Badge tone="neutral">{r.discountAuthority}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
