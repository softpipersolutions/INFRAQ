"use client";

import { useState } from "react";
import { Button, Card, Field, PageHeader, Select, TextInput } from "@/components/ui";
import { formatINR } from "@/lib/format";
import { trpc } from "@/trpc/react";

export default function PricesPage() {
  const snapshot = trpc.masters.snapshot.useQuery();
  const utils = trpc.useUtils();
  const setPrice = trpc.masters.setPrice.useMutation();

  const [materialCode, setMaterialCode] = useState("");
  const [makeCode, setMakeCode] = useState("");
  const [buying, setBuying] = useState("");
  const [selling, setSelling] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const materials = snapshot.data?.materials ?? [];
  const makes = snapshot.data?.makes ?? [];
  const prices = snapshot.data?.prices ?? [];
  const makesForMaterial = makes.filter((m) => m.materialCode === materialCode);

  async function onSave() {
    setMsg(null);
    if (!materialCode || !makeCode) {
      setMsg("Pick a material and make.");
      return;
    }
    try {
      await setPrice.mutateAsync({
        materialCode,
        makeCode,
        buyingRateRupees: Number(buying),
        sellingRateRupees: Number(selling),
      });
      setMsg("Price set (supersedes any current rate).");
      await utils.masters.snapshot.invalidate();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div>
      <PageHeader title="Prices (A.04)" subtitle="Current buying / selling rates. Setting a rate supersedes the prior one." />
      <Card className="mb-6 p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Field label="Material">
            <Select
              value={materialCode}
              onChange={(e) => {
                setMaterialCode(e.target.value);
                setMakeCode("");
              }}
            >
              <option value="">Select…</option>
              {materials.map((m) => (
                <option key={m.materialCode} value={m.materialCode}>
                  {m.materialCode}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Make">
            <Select value={makeCode} onChange={(e) => setMakeCode(e.target.value)}>
              <option value="">Select…</option>
              {makesForMaterial.map((m) => (
                <option key={m.makeCode} value={m.makeCode}>
                  {m.brandName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Buying rate (₹)">
            <TextInput type="number" min={0} step="0.01" value={buying} onChange={(e) => setBuying(e.target.value)} />
          </Field>
          <Field label="Selling rate (₹)">
            <TextInput type="number" min={0} step="0.01" value={selling} onChange={(e) => setSelling(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" disabled={setPrice.isPending} onClick={onSave}>
            {setPrice.isPending ? "Saving…" : "Set current price"}
          </Button>
          {msg ? <span className="text-sm text-[var(--pebble-muted)]">{msg}</span> : null}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-[var(--pebble-border)] px-4 py-2 text-sm font-semibold">
          Current prices ({prices.length})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--pebble-border)] text-left text-xs uppercase tracking-wide text-[var(--pebble-muted)]">
                <th className="px-3 py-2">Material</th>
                <th className="px-3 py-2">Make</th>
                <th className="px-3 py-2 text-right tabular">Buying</th>
                <th className="px-3 py-2 text-right tabular">Selling</th>
                <th className="px-3 py-2">Effective</th>
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => (
                <tr key={p.priceId} className="border-b border-[var(--pebble-border)] last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{p.materialCode}</td>
                  <td className="px-3 py-2 font-mono text-xs">{p.makeCode}</td>
                  <td className="px-3 py-2 text-right tabular">{formatINR(p.buyingRatePaise)}</td>
                  <td className="px-3 py-2 text-right tabular">{formatINR(p.sellingRatePaise)}</td>
                  <td className="px-3 py-2 text-xs text-[var(--pebble-muted)]">{p.effectiveFrom.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
