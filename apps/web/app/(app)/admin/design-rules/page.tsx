"use client";

import { useState } from "react";
import { SYSTEM_TYPES } from "@pebble/shared";
import { Badge, Button, Card, Field, PageHeader, Select, TextInput } from "@/components/ui";
import { trpc } from "@/trpc/react";

export default function DesignRulesPage() {
  const snapshot = trpc.masters.snapshot.useQuery();
  const utils = trpc.useUtils();
  const validate = trpc.masters.validateDesignRule.useMutation();
  const create = trpc.masters.createDesignRule.useMutation();

  const [ruleCode, setRuleCode] = useState("");
  const [systemType, setSystemType] = useState<string>("FAS");
  const [conditionExpr, setConditionExpr] = useState("system = FAS");
  const [quantityFormula, setQuantityFormula] = useState("CEIL(total_area_sqm / 60)");
  const [outputMaterialCode, setOutputMaterialCode] = useState("");
  const [standardReference, setStandardReference] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const materials = snapshot.data?.materials ?? [];
  const rules = snapshot.data?.rules ?? [];

  async function onValidate() {
    setMsg(null);
    await validate.mutateAsync({ conditionExpr, quantityFormula });
  }

  async function onSave() {
    setMsg(null);
    if (!outputMaterialCode) {
      setMsg("Pick an output material.");
      return;
    }
    try {
      await create.mutateAsync({
        ruleCode,
        systemType: systemType as (typeof SYSTEM_TYPES)[number],
        conditionExpr,
        quantityFormula,
        outputMaterialCode,
        standardReference: standardReference.trim() === "" ? null : standardReference.trim(),
      });
      setMsg("Rule saved.");
      setRuleCode("");
      await utils.masters.snapshot.invalidate();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Save failed");
    }
  }

  const v = validate.data;

  return (
    <div>
      <PageHeader
        title="Design rules (A.06)"
        subtitle="User-authored rules run through the safe expression engine with a save-time dry-run."
      />

      <Card className="mb-6 p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Rule code">
            <TextInput value={ruleCode} onChange={(e) => setRuleCode(e.target.value)} placeholder="DL-FAS-010" />
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
          <Field label="Condition expression">
            <TextInput value={conditionExpr} onChange={(e) => setConditionExpr(e.target.value)} />
          </Field>
          <Field label="Quantity formula">
            <TextInput value={quantityFormula} onChange={(e) => setQuantityFormula(e.target.value)} />
          </Field>
          <Field label="Output material">
            <Select value={outputMaterialCode} onChange={(e) => setOutputMaterialCode(e.target.value)}>
              <option value="">Select…</option>
              {materials.map((m) => (
                <option key={m.materialCode} value={m.materialCode}>
                  {m.materialCode} · {m.materialName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Standard reference">
            <TextInput
              value={standardReference}
              onChange={(e) => setStandardReference(e.target.value)}
              placeholder="IS 2189 cl.6 spacing"
            />
          </Field>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button variant="secondary" disabled={validate.isPending} onClick={onValidate}>
            {validate.isPending ? "Validating…" : "Validate & dry-run"}
          </Button>
          <Button variant="primary" disabled={create.isPending} onClick={onSave}>
            {create.isPending ? "Saving…" : "Save rule"}
          </Button>
          {msg ? <span className="text-sm text-ink-muted">{msg}</span> : null}
        </div>

        {v ? (
          <div className="mt-4 space-y-3 border-t border-border pt-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Condition</span>
              {v.condition.ok ? <Badge tone="success">valid</Badge> : <Badge tone="danger">invalid</Badge>}
              {v.condition.issues.map((i, idx) => (
                <span key={idx} className="text-danger">
                  {i.code}: {i.message}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Quantity</span>
              {v.quantity.ok ? <Badge tone="success">valid</Badge> : <Badge tone="danger">invalid</Badge>}
              {v.quantity.issues.map((i, idx) => (
                <span key={idx} className="text-danger">
                  {i.code}: {i.message}
                </span>
              ))}
            </div>
            {v.samples.length > 0 ? (
              <div>
                <div className="mb-1 text-sm font-medium">Dry-run against sample enquiries</div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                      <th className="py-1">Sample</th>
                      <th className="py-1">Condition</th>
                      <th className="py-1">Quantity</th>
                      <th className="py-1">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.samples.map((s, idx) => (
                      <tr key={idx} className="border-t border-border">
                        <td className="py-1">{s.label}</td>
                        <td className="py-1">{s.conditionResult === null ? "—" : String(s.conditionResult)}</td>
                        <td className="py-1 tabular">{s.quantityResult === null ? "—" : s.quantityResult}</td>
                        <td className="py-1 text-danger">{s.error ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-2 text-sm font-semibold">
          Active rules ({rules.length})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="px-3 py-2">Rule</th>
                <th className="px-3 py-2">System</th>
                <th className="px-3 py-2">Condition</th>
                <th className="px-3 py-2">Quantity</th>
                <th className="px-3 py-2">Output</th>
                <th className="px-3 py-2">Reference</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.ruleId} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 tabular font-medium">
                    {r.ruleCode}
                    <span className="ml-1 text-xs text-ink-muted">v{r.ruleVersion}</span>
                  </td>
                  <td className="px-3 py-2">{r.systemType}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.conditionExpr}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.quantityFormula}</td>
                  <td className="px-3 py-2 tabular">{r.outputMaterialCode}</td>
                  <td className="px-3 py-2 text-xs text-ink-muted">{r.standardReference ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
