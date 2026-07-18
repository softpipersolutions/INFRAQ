"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { PricedLine } from "@pebble/shared";
import { MarginBadge, SitcBadge } from "@/components/badges";
import { Badge, Button, Card, EmptyState, PageHeader, Select, TextInput } from "@/components/ui";
import { formatINR } from "@/lib/format";
import { trpc } from "@/trpc/react";

type MakeOption = { makeCode: string; brandName: string; tier: string; approvalStatus: string };

export default function EstimatePage() {
  const params = useParams<{ id: string }>();
  const estimateId = params.id;
  const utils = trpc.useUtils();

  const base = trpc.estimate.get.useQuery({ estimateId });
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const versioned = trpc.estimate.getVersion.useQuery(
    { estimateId, versionNo: viewVersion ?? 1 },
    { enabled: viewVersion !== null },
  );
  const snapshot = trpc.masters.snapshot.useQuery();

  const startReview = trpc.estimate.startReview.useMutation({
    onSuccess: () => {
      setViewVersion(null);
      void utils.estimate.get.invalidate({ estimateId });
      void utils.dashboard.stats.invalidate();
    },
  });
  const approve = trpc.estimate.approve.useMutation();

  const view = viewVersion !== null && versioned.data ? versioned.data : base.data;
  const [overrideSitc, setOverrideSitc] = useState(false);
  const [approveMsg, setApproveMsg] = useState<string | null>(null);

  const makesByMaterial = useMemo(() => {
    const map = new Map<string, MakeOption[]>();
    for (const mk of snapshot.data?.makes ?? []) {
      const list = map.get(mk.materialCode) ?? [];
      list.push({
        makeCode: mk.makeCode,
        brandName: mk.brandName,
        tier: mk.tier,
        approvalStatus: mk.approvalStatus,
      });
      map.set(mk.materialCode, list);
    }
    return map;
  }, [snapshot.data]);

  if (base.isLoading) return <EmptyState>Loading estimate…</EmptyState>;
  if (base.isError) return <EmptyState>Failed to load: {base.error.message}</EmptyState>;
  if (!view) return <EmptyState>Estimate not found.</EmptyState>;

  const isCurrent = viewVersion === null || viewVersion === view.estimate.currentVersion;
  const working = view.version.state === "WORKING";
  const editable = working && isCurrent;

  const sections = groupSections(view.lines);

  async function onApprove() {
    setApproveMsg(null);
    try {
      const res = await approve.mutateAsync({ estimateId, overrideSitc });
      const note = res.requiredAuthority
        ? `Approved. Margin below floor — discount authority ${res.requiredAuthority} required.`
        : "Approved.";
      setApproveMsg(note);
      await utils.estimate.get.invalidate({ estimateId });
      await utils.dashboard.stats.invalidate();
    } catch (err) {
      setApproveMsg(err instanceof Error ? err.message : "Approval failed");
    }
  }

  return (
    <div>
      <PageHeader
        title={estimateId}
        subtitle={view.enquiry ? `${view.enquiry.projectName} · ${view.enquiry.clientName}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Link href={`/estimates/${estimateId}/audit`}>
              <Button variant="ghost">Audit</Button>
            </Link>
            {view.versions.length >= 2 ? (
              <Link
                href={`/estimates/${estimateId}/compare?a=${view.versions[0]!.versionNo}&b=${view.versions[view.versions.length - 1]!.versionNo}`}
              >
                <Button variant="ghost">Compare</Button>
              </Link>
            ) : null}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Badge tone="neutral">{view.estimate.status}</Badge>
        <Badge tone={working ? "amber" : "blue"}>
          v{view.version.versionNo} · {view.version.state}
        </Badge>
        <SitcBadge status={view.estimate.sitcStatus} ratio={view.version.blendedRatio} />
        <MarginBadge
          status={view.estimate.marginStatus}
          marginPct={view.version.marginPct}
          requiredAuthority={view.estimate.requiredAuthority}
        />
        <div className="ml-auto flex items-center gap-2 text-sm">
          <span className="text-[var(--pebble-muted)]">Version</span>
          <Select
            value={String(view.version.versionNo)}
            onChange={(e) => {
              const n = Number(e.target.value);
              setViewVersion(n === view.estimate.currentVersion ? null : n);
            }}
            className="w-auto"
          >
            {view.versions.map((v) => (
              <option key={v.versionNo} value={v.versionNo}>
                v{v.versionNo} ({v.state})
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* Totals + warnings */}
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="p-4 md:col-span-2">
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <Total label="Supply" paise={view.version.totalSupplyPaise} />
            <Total label="Install" paise={view.version.totalInstallPaise} />
            <Total label="SITC total" paise={view.version.totalSitcPaise} />
            <Total label="GST (18%)" paise={view.version.gstPaise} />
          </div>
          <div className="mt-3 border-t border-[var(--pebble-border)] pt-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium">Grand total</span>
              <span className="text-lg font-semibold tabular">{formatINR(view.version.grandTotalPaise)}</span>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="mb-2 text-sm font-semibold">Warnings</div>
          {view.warnings.length === 0 ? (
            <div className="text-sm text-green-700">No generation warnings.</div>
          ) : (
            <ul className="space-y-1 text-sm text-amber-800">
              {view.warnings.map((w, i) => (
                <li key={i}>
                  <span className="font-medium">{w.kind}</span>: {w.message}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Actions */}
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          {!working && isCurrent && view.estimate.status !== "APPROVED" && view.estimate.status !== "DISPATCHED" ? (
            <Button variant="primary" disabled={startReview.isPending} onClick={() => startReview.mutate({ estimateId })}>
              {startReview.isPending ? "Forking…" : "Start review (fork working copy)"}
            </Button>
          ) : null}

          {editable ? (
            <>
              {view.estimate.sitcStatus === "ALERT" ? (
                <label className="flex items-center gap-2 text-sm text-red-700">
                  <input type="checkbox" checked={overrideSitc} onChange={(e) => setOverrideSitc(e.target.checked)} />
                  Override SITC alert
                </label>
              ) : null}
              <Button variant="primary" disabled={approve.isPending} onClick={onApprove}>
                {approve.isPending ? "Approving…" : "Approve"}
              </Button>
            </>
          ) : null}

          {view.estimate.status === "APPROVED" ? <Badge tone="green">Approved</Badge> : null}
          {approveMsg ? <span className="text-sm text-[var(--pebble-muted)]">{approveMsg}</span> : null}
        </div>
      </Card>

      {/* Line grid grouped by system section */}
      {sections.map((section) => (
        <Card key={section.systemType} className="mb-4 overflow-hidden">
          <div className="border-b border-[var(--pebble-border)] bg-slate-50 px-4 py-2 text-sm font-semibold">
            {section.systemType}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--pebble-border)] text-left text-xs uppercase tracking-wide text-[var(--pebble-muted)]">
                  <th className="px-3 py-2">Material</th>
                  <th className="px-3 py-2">Make</th>
                  <th className="px-3 py-2 text-right tabular">Qty</th>
                  <th className="px-3 py-2">Unit</th>
                  <th className="px-3 py-2 text-right tabular">Supply rate</th>
                  <th className="px-3 py-2 text-right tabular">Install rate</th>
                  <th className="px-3 py-2 text-right tabular">SITC rate</th>
                  <th className="px-3 py-2 text-right tabular">Amount</th>
                  {editable ? <th className="px-3 py-2" /> : null}
                </tr>
              </thead>
              <tbody>
                {section.lines.map((line) => (
                  <LineRow
                    key={line.lineUid}
                    estimateId={estimateId}
                    line={line}
                    makeOptions={makesByMaterial.get(line.materialCode) ?? []}
                    editable={editable}
                    onChanged={() => {
                      void utils.estimate.get.invalidate({ estimateId });
                      void utils.dashboard.stats.invalidate();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}

      {editable ? <AddLineForm estimateId={estimateId} onAdded={() => utils.estimate.get.invalidate({ estimateId })} /> : null}
    </div>
  );
}

function Total({ label, paise }: { label: string; paise: number }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[var(--pebble-muted)]">{label}</div>
      <div className="tabular font-medium">{formatINR(paise)}</div>
    </div>
  );
}

interface Section {
  systemType: string;
  sectionOrder: number;
  lines: PricedLine[];
}

function groupSections(lines: PricedLine[]): Section[] {
  const map = new Map<string, Section>();
  for (const line of lines) {
    const existing = map.get(line.systemType);
    if (existing) existing.lines.push(line);
    else map.set(line.systemType, { systemType: line.systemType, sectionOrder: line.sectionOrder, lines: [line] });
  }
  const sections = [...map.values()];
  sections.sort((a, b) => a.sectionOrder - b.sectionOrder);
  for (const s of sections) s.lines.sort((a, b) => a.lineOrder - b.lineOrder);
  return sections;
}

function LineRow({
  estimateId,
  line,
  makeOptions,
  editable,
  onChanged,
}: {
  estimateId: string;
  line: PricedLine;
  makeOptions: MakeOption[];
  editable: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(String(line.qty));
  const [makeCode, setMakeCode] = useState(line.makeCode ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const edit = trpc.estimate.editLine.useMutation();
  const remove = trpc.estimate.removeLine.useMutation();

  async function save() {
    setError(null);
    if (reason.trim() === "") {
      setError("Edit reason is required.");
      return;
    }
    try {
      await edit.mutateAsync({
        estimateId,
        lineUid: line.lineUid,
        qty: Number(qty),
        makeCode: makeCode || undefined,
        editReason: reason.trim(),
      });
      setOpen(false);
      setReason("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Edit failed");
    }
  }

  async function onRemove() {
    const r = window.prompt("Reason for removing this line?", "Removed during review");
    if (!r) return;
    try {
      await remove.mutateAsync({ estimateId, lineUid: line.lineUid, editReason: r });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    }
  }

  return (
    <>
      <tr className="border-b border-[var(--pebble-border)] align-top last:border-0">
        <td className="px-3 py-2">
          <div className="font-medium">{line.description}</div>
          <div className="text-xs text-[var(--pebble-muted)]">
            {line.materialCode}
            {line.ruleCode ? ` · ${line.ruleCode}` : ""}
            {line.source === "MANUAL" ? " · manual" : ""}
          </div>
        </td>
        <td className="px-3 py-2">{line.brandName ?? "—"}</td>
        <td className="px-3 py-2 text-right tabular">{line.qty}</td>
        <td className="px-3 py-2">{line.unit}</td>
        <td className="px-3 py-2 text-right tabular">{formatINR(line.supplyRatePaise)}</td>
        <td className="px-3 py-2 text-right tabular">{formatINR(line.installRatePaise)}</td>
        <td className="px-3 py-2 text-right tabular">{formatINR(line.sitcRatePaise)}</td>
        <td className="px-3 py-2 text-right tabular font-medium">{formatINR(line.lineAmountPaise)}</td>
        {editable ? (
          <td className="px-3 py-2 text-right">
            <div className="flex justify-end gap-2">
              <button className="text-xs text-[var(--pebble-accent)] hover:underline" onClick={() => setOpen((o) => !o)}>
                {open ? "Close" : "Edit"}
              </button>
              <button className="text-xs text-red-600 hover:underline" onClick={onRemove}>
                Remove
              </button>
            </div>
          </td>
        ) : null}
      </tr>
      {open && editable ? (
        <tr className="border-b border-[var(--pebble-border)] bg-slate-50">
          <td colSpan={9} className="px-3 py-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <label className="text-sm">
                <span className="mb-1 block font-medium">Qty</span>
                <TextInput type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">Make</span>
                <Select value={makeCode} onChange={(e) => setMakeCode(e.target.value)}>
                  {makeOptions.map((m) => (
                    <option key={m.makeCode} value={m.makeCode}>
                      {m.brandName} ({m.tier}/{m.approvalStatus})
                    </option>
                  ))}
                </Select>
              </label>
              <label className="text-sm md:col-span-2">
                <span className="mb-1 block font-medium">Edit reason</span>
                <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this changing?" />
              </label>
            </div>
            {error ? <div className="mt-2 text-sm text-red-700">{error}</div> : null}
            <div className="mt-3 flex gap-2">
              <Button variant="primary" disabled={edit.isPending} onClick={save}>
                {edit.isPending ? "Saving…" : "Save & recompute"}
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function AddLineForm({ estimateId, onAdded }: { estimateId: string; onAdded: () => void }) {
  const snapshot = trpc.masters.snapshot.useQuery();
  const add = trpc.estimate.addLine.useMutation();
  const [materialCode, setMaterialCode] = useState("");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const materials = snapshot.data?.materials ?? [];

  async function onAdd() {
    setError(null);
    if (!materialCode) {
      setError("Pick a material.");
      return;
    }
    if (reason.trim() === "") {
      setError("Reason is required.");
      return;
    }
    try {
      await add.mutateAsync({ estimateId, materialCode, qty: Number(qty), editReason: reason.trim() });
      setReason("");
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add failed");
    }
  }

  return (
    <Card className="p-4">
      <div className="mb-2 text-sm font-semibold">Add a line</div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <label className="text-sm md:col-span-2">
          <span className="mb-1 block font-medium">Material</span>
          <Select value={materialCode} onChange={(e) => setMaterialCode(e.target.value)}>
            <option value="">Select…</option>
            {materials.map((m) => (
              <option key={m.materialCode} value={m.materialCode}>
                {m.materialCode} · {m.materialName}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Qty</span>
          <TextInput type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Reason</span>
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      {error ? <div className="mt-2 text-sm text-red-700">{error}</div> : null}
      <div className="mt-3">
        <Button variant="secondary" disabled={add.isPending} onClick={onAdd}>
          {add.isPending ? "Adding…" : "Add line"}
        </Button>
      </div>
    </Card>
  );
}
