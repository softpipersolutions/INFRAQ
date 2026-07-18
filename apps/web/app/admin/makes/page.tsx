"use client";

import { useState } from "react";
import { APPROVAL_STATUSES, MAKE_TIERS, makeSchema } from "@pebble/shared";
import { Badge, Button, Card, Field, PageHeader, Select, TextInput } from "@/components/ui";
import { trpc } from "@/trpc/react";

export default function MakesPage() {
  const snapshot = trpc.masters.snapshot.useQuery();
  const utils = trpc.useUtils();
  const create = trpc.masters.createMake.useMutation();

  const [makeCode, setMakeCode] = useState("");
  const [materialCode, setMaterialCode] = useState("");
  const [brandName, setBrandName] = useState("");
  const [tier, setTier] = useState<string>("Standard");
  const [approvalStatus, setApproval] = useState<string>("Approved");
  const [msg, setMsg] = useState<string | null>(null);

  const materials = snapshot.data?.materials ?? [];
  const makes = snapshot.data?.makes ?? [];

  async function onCreate() {
    setMsg(null);
    const parsed = makeSchema.safeParse({ makeCode, materialCode, brandName, tier, approvalStatus, notes: null });
    if (!parsed.success) {
      setMsg(parsed.error.issues.map((i) => i.message).join(", "));
      return;
    }
    try {
      await create.mutateAsync(parsed.data);
      setMsg("Make created.");
      setMakeCode("");
      setBrandName("");
      await utils.masters.snapshot.invalidate();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Create failed");
    }
  }

  return (
    <div>
      <PageHeader title="Makes & brands (A.03)" subtitle="Approved makes per material with tier and approval status." />
      <Card className="mb-6 p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Make code">
            <TextInput value={makeCode} onChange={(e) => setMakeCode(e.target.value)} placeholder="FAS-SMK-001-XYZ" />
          </Field>
          <Field label="Material">
            <Select value={materialCode} onChange={(e) => setMaterialCode(e.target.value)}>
              <option value="">Select…</option>
              {materials.map((m) => (
                <option key={m.materialCode} value={m.materialCode}>
                  {m.materialCode}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Brand">
            <TextInput value={brandName} onChange={(e) => setBrandName(e.target.value)} />
          </Field>
          <Field label="Tier">
            <Select value={tier} onChange={(e) => setTier(e.target.value)}>
              {MAKE_TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Approval">
            <Select value={approvalStatus} onChange={(e) => setApproval(e.target.value)}>
              {APPROVAL_STATUSES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" disabled={create.isPending} onClick={onCreate}>
            {create.isPending ? "Creating…" : "Create make"}
          </Button>
          {msg ? <span className="text-sm text-[var(--pebble-muted)]">{msg}</span> : null}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-[var(--pebble-border)] px-4 py-2 text-sm font-semibold">Makes ({makes.length})</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--pebble-border)] text-left text-xs uppercase tracking-wide text-[var(--pebble-muted)]">
                <th className="px-3 py-2">Make</th>
                <th className="px-3 py-2">Material</th>
                <th className="px-3 py-2">Brand</th>
                <th className="px-3 py-2">Tier</th>
                <th className="px-3 py-2">Approval</th>
              </tr>
            </thead>
            <tbody>
              {makes.map((m) => (
                <tr key={m.makeCode} className="border-b border-[var(--pebble-border)] last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{m.makeCode}</td>
                  <td className="px-3 py-2 font-mono text-xs">{m.materialCode}</td>
                  <td className="px-3 py-2">{m.brandName}</td>
                  <td className="px-3 py-2">{m.tier}</td>
                  <td className="px-3 py-2">
                    <Badge tone={m.approvalStatus === "Approved" ? "green" : m.approvalStatus === "Conditional" ? "amber" : "red"}>
                      {m.approvalStatus}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
