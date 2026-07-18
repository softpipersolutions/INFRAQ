"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  APPLICABLE_STANDARDS,
  BUILDING_TYPES,
  MAKE_PREFERENCES,
  PROJECT_TIERS,
  SYSTEM_TYPES,
  enquiryInputSchema,
} from "@pebble/shared";
import { Button, Card, Field, PageHeader, Select, TextInput, Textarea } from "@/components/ui";
import { trpc } from "@/trpc/react";

const SYSTEM_OPTIONS = SYSTEM_TYPES.filter((s) => s !== "Common");

export default function NewEnquiryPage() {
  const router = useRouter();
  const create = trpc.enquiry.create.useMutation();

  const [clientName, setClientName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [buildingType, setBuildingType] = useState<string>("Commercial");
  const [floorsAbove, setFloorsAbove] = useState("4");
  const [floorAreaSqm, setFloorAreaSqm] = useState("450");
  const [systems, setSystems] = useState<string[]>(["FAS", "Extinguisher"]);
  const [makePreference, setMakePreference] = useState<string>("As per Greenberg");
  const [applicableStandard, setApplicableStandard] = useState<string>("IS");
  const [projectTier, setProjectTier] = useState("2");
  const [clientEmail, setClientEmail] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  function toggleSystem(system: string) {
    setSystems((prev) =>
      prev.includes(system) ? prev.filter((s) => s !== system) : [...prev, system],
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const candidate = {
      clientName,
      projectName,
      buildingType,
      floorsAbove: Number(floorsAbove),
      floorAreaSqm: Number(floorAreaSqm),
      systemsRequired: systems,
      makePreference,
      applicableStandard,
      projectTier: Number(projectTier),
      clientEmail: clientEmail.trim() === "" ? null : clientEmail.trim(),
      clientPhone: clientPhone.trim() === "" ? null : clientPhone.trim(),
      notes: notes.trim() === "" ? null : notes.trim(),
      source: "form" as const,
    };

    const parsed = enquiryInputSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(".") || "form"}: ${i.message}`).join(" · "));
      return;
    }

    try {
      const result = await create.mutateAsync(parsed.data);
      router.push(`/estimates/${result.estimateId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create enquiry");
    }
  }

  return (
    <div>
      <PageHeader
        title="New enquiry"
        subtitle="A.08 enquiry input — submitting generates a priced draft (v1, locked) immediately."
      />

      <form onSubmit={onSubmit}>
        <Card className="mb-4 p-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Client name">
              <TextInput value={clientName} onChange={(e) => setClientName(e.target.value)} required />
            </Field>
            <Field label="Project name">
              <TextInput value={projectName} onChange={(e) => setProjectName(e.target.value)} required />
            </Field>
            <Field label="Building type">
              <Select value={buildingType} onChange={(e) => setBuildingType(e.target.value)}>
                {BUILDING_TYPES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Project tier (1–4)">
              <Select value={projectTier} onChange={(e) => setProjectTier(e.target.value)}>
                {PROJECT_TIERS.map((t) => (
                  <option key={t} value={t}>
                    Tier {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Floors above ground">
              <TextInput
                type="number"
                min={0}
                value={floorsAbove}
                onChange={(e) => setFloorsAbove(e.target.value)}
              />
            </Field>
            <Field label="Floor area (sqm)">
              <TextInput
                type="number"
                min={1}
                step="0.01"
                value={floorAreaSqm}
                onChange={(e) => setFloorAreaSqm(e.target.value)}
              />
            </Field>
            <Field label="Make preference">
              <Select value={makePreference} onChange={(e) => setMakePreference(e.target.value)}>
                {MAKE_PREFERENCES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Applicable standard">
              <Select value={applicableStandard} onChange={(e) => setApplicableStandard(e.target.value)}>
                {APPLICABLE_STANDARDS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="mt-4">
            <span className="mb-2 block text-sm font-medium">Systems required</span>
            <div className="flex flex-wrap gap-2">
              {SYSTEM_OPTIONS.map((system) => {
                const active = systems.includes(system);
                return (
                  <button
                    type="button"
                    key={system}
                    onClick={() => toggleSystem(system)}
                    className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                      active
                        ? "border-[var(--pebble-accent)] bg-red-50 text-[var(--pebble-accent)]"
                        : "border-[var(--pebble-border)] bg-white text-[var(--pebble-ink)] hover:bg-slate-50"
                    }`}
                  >
                    {system}
                  </button>
                );
              })}
            </div>
          </div>
        </Card>

        <Card className="mb-4 p-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Client email (optional)">
              <TextInput
                type="email"
                value={clientEmail}
                onChange={(e) => setClientEmail(e.target.value)}
              />
            </Field>
            <Field label="Client phone (optional)">
              <TextInput value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} />
            </Field>
          </div>
          <div className="mt-4">
            <Field label="Notes (optional)">
              <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        </Card>

        {error ? (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? "Generating…" : "Create & generate"}
          </Button>
          <span className="text-sm text-[var(--pebble-muted)]">
            {systems.length} system{systems.length === 1 ? "" : "s"} selected
          </span>
        </div>
      </form>
    </div>
  );
}
