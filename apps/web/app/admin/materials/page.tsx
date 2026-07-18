"use client";

import { useState } from "react";
import { MATERIAL_CATEGORIES, SYSTEM_TYPES, UNITS_OF_MEASURE, materialSchema } from "@pebble/shared";
import { Badge, Button, Card, Field, PageHeader, Select, TextInput } from "@/components/ui";
import { trpc } from "@/trpc/react";

export default function MaterialsPage() {
  const snapshot = trpc.masters.snapshot.useQuery();
  const utils = trpc.useUtils();
  const create = trpc.masters.createMaterial.useMutation();

  const [materialCode, setMaterialCode] = useState("");
  const [materialName, setMaterialName] = useState("");
  const [systemType, setSystemType] = useState<string>("FAS");
  const [category, setCategory] = useState<string>("Detector");
  const [unitOfMeasure, setUnit] = useState<string>("No.");
  const [msg, setMsg] = useState<string | null>(null);

  async function onCreate() {
    setMsg(null);
    const parsed = materialSchema.safeParse({
      materialCode,
      materialName,
      systemType,
      category,
      unitOfMeasure,
      active: true,
    });
    if (!parsed.success) {
      setMsg(parsed.error.issues.map((i) => i.message).join(", "));
      return;
    }
    try {
      await create.mutateAsync(parsed.data);
      setMsg("Material created.");
      setMaterialCode("");
      setMaterialName("");
      await utils.masters.snapshot.invalidate();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Create failed");
    }
  }

  const materials = snapshot.data?.materials ?? [];

  return (
    <div>
      <PageHeader title="Materials (A.01)" subtitle="Master material register." />
      <Card className="mb-6 p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Material code">
            <TextInput value={materialCode} onChange={(e) => setMaterialCode(e.target.value)} placeholder="FAS-XYZ-001" />
          </Field>
          <Field label="Material name">
            <TextInput value={materialName} onChange={(e) => setMaterialName(e.target.value)} />
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
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {MATERIAL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unit">
            <Select value={unitOfMeasure} onChange={(e) => setUnit(e.target.value)}>
              {UNITS_OF_MEASURE.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" disabled={create.isPending} onClick={onCreate}>
            {create.isPending ? "Creating…" : "Create material"}
          </Button>
          {msg ? <span className="text-sm text-[var(--pebble-muted)]">{msg}</span> : null}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-[var(--pebble-border)] px-4 py-2 text-sm font-semibold">
          Materials ({materials.length})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--pebble-border)] text-left text-xs uppercase tracking-wide text-[var(--pebble-muted)]">
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">System</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Unit</th>
                <th className="px-3 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.materialCode} className="border-b border-[var(--pebble-border)] last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{m.materialCode}</td>
                  <td className="px-3 py-2">{m.materialName}</td>
                  <td className="px-3 py-2">{m.systemType}</td>
                  <td className="px-3 py-2">{m.category}</td>
                  <td className="px-3 py-2">{m.unitOfMeasure}</td>
                  <td className="px-3 py-2">
                    {m.active ? <Badge tone="green">active</Badge> : <Badge tone="neutral">inactive</Badge>}
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
