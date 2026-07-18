"use client";

import { useState } from "react";
import { INSTALL_RATE_UNITS, SYSTEM_TYPES } from "@pebble/shared";
import { Button, Card, Field, PageHeader, Select, TextInput } from "@/components/ui";
import { formatINR } from "@/lib/format";
import { trpc } from "@/trpc/react";

export default function InstallRatesPage() {
  const snapshot = trpc.masters.snapshot.useQuery();
  const utils = trpc.useUtils();
  const create = trpc.masters.createInstallRate.useMutation();

  const [rateCode, setRateCode] = useState("");
  const [description, setDescription] = useState("");
  const [systemType, setSystemType] = useState<string>("FAS");
  const [linkedMaterialCode, setLinked] = useState<string>("");
  const [rateRupees, setRate] = useState("");
  const [unit, setUnit] = useState<string>("Per No.");
  const [msg, setMsg] = useState<string | null>(null);

  const materials = snapshot.data?.materials ?? [];
  const installRates = snapshot.data?.installRates ?? [];

  async function onCreate() {
    setMsg(null);
    if (!rateCode || !description) {
      setMsg("Rate code and description required.");
      return;
    }
    try {
      await create.mutateAsync({
        rateCode,
        description,
        systemType: systemType as (typeof SYSTEM_TYPES)[number],
        linkedMaterialCode: linkedMaterialCode || null,
        rateRupees: Number(rateRupees),
        unit: unit as (typeof INSTALL_RATE_UNITS)[number],
      });
      setMsg("Install rate created.");
      setRateCode("");
      setDescription("");
      await utils.masters.snapshot.invalidate();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Create failed");
    }
  }

  return (
    <div>
      <PageHeader title="Install rates (A.05)" subtitle="SITC labour rates — material-linked or system-generic." />
      <Card className="mb-6 p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Rate code">
            <TextInput value={rateCode} onChange={(e) => setRateCode(e.target.value)} placeholder="INST-FAS-XYZ" />
          </Field>
          <Field label="Description">
            <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="System">
            <Select value={systemType} onChange={(e) => setSystemType(e.target.value)}>
              {SYSTEM_TYPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Linked material (optional)">
            <Select value={linkedMaterialCode} onChange={(e) => setLinked(e.target.value)}>
              <option value="">Generic (none)</option>
              {materials.map((m) => (
                <option key={m.materialCode} value={m.materialCode}>
                  {m.materialCode}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Rate (₹)">
            <TextInput type="number" min={0} step="0.01" value={rateRupees} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <Field label="Unit">
            <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {INSTALL_RATE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" disabled={create.isPending} onClick={onCreate}>
            {create.isPending ? "Creating…" : "Create install rate"}
          </Button>
          {msg ? <span className="text-sm text-[var(--pebble-muted)]">{msg}</span> : null}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-[var(--pebble-border)] px-4 py-2 text-sm font-semibold">
          Install rates ({installRates.length})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--pebble-border)] text-left text-xs uppercase tracking-wide text-[var(--pebble-muted)]">
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2">System</th>
                <th className="px-3 py-2">Linked</th>
                <th className="px-3 py-2 text-right tabular">Rate</th>
                <th className="px-3 py-2">Unit</th>
              </tr>
            </thead>
            <tbody>
              {installRates.map((r) => (
                <tr key={`${r.rateCode}-${r.effectiveFrom}`} className="border-b border-[var(--pebble-border)] last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{r.rateCode}</td>
                  <td className="px-3 py-2">{r.description}</td>
                  <td className="px-3 py-2">{r.systemType}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.linkedMaterialCode ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular">{formatINR(r.ratePaise)}</td>
                  <td className="px-3 py-2">{r.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
