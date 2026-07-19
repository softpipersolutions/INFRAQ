"use client";

import { useEffect, useState } from "react";
import {
  INSTALL_RATE_UNITS,
  MAKE_TIERS,
  MATERIAL_CATEGORIES,
  STAGED_RATE_KINDS,
  SYSTEM_TYPES,
  UNITS_OF_MEASURE,
  type TargetMaster,
} from "@pebble/shared";
import { Field, Select, TextInput, Textarea } from "@/components/ui";

type Json = Record<string, unknown>;

/** The DOM id the "e" keyboard shortcut focuses — always the form's first input. */
export const FIRST_FIELD_ID = "staged-form-first-field";

function obj(v: unknown): Json {
  return v && typeof v === "object" ? (v as Json) : {};
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function numStr(v: unknown): string {
  return typeof v === "number" ? String(v) : "";
}
function isoToDateInput(v: unknown): string {
  const s = str(v);
  return s.length >= 10 ? s.slice(0, 10) : "";
}
function dateInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Editable staged-payload form, switched on targetMaster. Fully controlled:
 * emits the whole rebuilt payload (via onChange) on every keystroke so the
 * parent can send it verbatim as `edits` to `ingestion.editApprove` — the
 * repo does a SHALLOW merge of edits over the original proposed object, so
 * sending the complete rebuilt object reproduces the intended result exactly
 * regardless of which fields actually changed.
 */
export function StagedPayloadForm({
  targetMaster,
  proposed,
  onChange,
}: {
  targetMaster: TargetMaster;
  proposed: Json;
  onChange: (value: Json) => void;
}) {
  switch (targetMaster) {
    case "materials":
      return <MaterialBundleForm proposed={proposed} onChange={onChange} />;
    case "prices":
      return <PricePointForm proposed={proposed} onChange={onChange} />;
    case "makes":
      return <MakeLinkForm proposed={proposed} onChange={onChange} />;
    case "install_rates":
      return <InstallRateForm proposed={proposed} onChange={onChange} />;
    default:
      return null;
  }
}

function MaterialBundleForm({ proposed, onChange }: { proposed: Json; onChange: (v: Json) => void }) {
  const material = obj(proposed.material);
  const make = obj(proposed.make);
  const price = obj(proposed.price);
  const unitOfMeasure = obj(material.unitOfMeasure);
  const brandName = obj(make.brandName);
  const installRateInit = proposed.installRate === null ? null : obj(proposed.installRate);

  const [materialCode, setMaterialCode] = useState(str(material.materialCode));
  const [materialName, setMaterialName] = useState(str(material.materialName));
  const [systemType, setSystemType] = useState(str(material.systemType, SYSTEM_TYPES[0]));
  const [category, setCategory] = useState(str(material.category, MATERIAL_CATEGORIES[0]));
  const [unitRaw, setUnitRaw] = useState(str(unitOfMeasure.raw));
  const [unitNormalized, setUnitNormalized] = useState(str(unitOfMeasure.normalized));
  const [specSummary, setSpecSummary] = useState(str(material.specSummary));
  const [brandRaw, setBrandRaw] = useState(str(brandName.raw));
  const [brandNormalized, setBrandNormalized] = useState(str(brandName.normalized));
  const [tier, setTier] = useState(str(make.tier));
  const [sellRupees, setSellRupees] = useState(numStr(price.sellRupees));
  const [buyRupees, setBuyRupees] = useState(numStr(price.buyRupees));
  const [rateKind, setRateKind] = useState(str(price.rateKind, "UNKNOWN"));
  const [validFrom, setValidFrom] = useState(isoToDateInput(price.validFromISO));
  const [hasInstallRate, setHasInstallRate] = useState(installRateInit !== null);
  const [installRupees, setInstallRupees] = useState(installRateInit ? numStr(installRateInit.rupees) : "");
  const [installUnit, setInstallUnit] = useState(installRateInit ? str(installRateInit.unit, INSTALL_RATE_UNITS[0]) : INSTALL_RATE_UNITS[0]);

  useEffect(() => {
    onChange({
      ...proposed,
      material: {
        ...material,
        materialCode,
        materialName,
        systemType,
        category,
        unitOfMeasure: { raw: unitRaw, normalized: unitNormalized || null },
        ...(specSummary.trim() ? { specSummary } : {}),
      },
      make: {
        ...make,
        brandName: { raw: brandRaw, normalized: brandNormalized || null },
        tier: tier || null,
      },
      price: {
        ...price,
        sellRupees: sellRupees === "" ? null : Number(sellRupees),
        buyRupees: buyRupees === "" ? null : Number(buyRupees),
        rateKind,
        validFromISO: dateInputToIso(validFrom),
      },
      installRate: hasInstallRate ? { rupees: Number(installRupees || 0), unit: installUnit } : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    materialCode,
    materialName,
    systemType,
    category,
    unitRaw,
    unitNormalized,
    specSummary,
    brandRaw,
    brandNormalized,
    tier,
    sellRupees,
    buyRupees,
    rateKind,
    validFrom,
    hasInstallRate,
    installRupees,
    installUnit,
  ]);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Field label="Material code">
        <TextInput id={FIRST_FIELD_ID} value={materialCode} onChange={(e) => setMaterialCode(e.target.value)} />
      </Field>
      <Field label="Material name">
        <TextInput value={materialName} onChange={(e) => setMaterialName(e.target.value)} />
      </Field>
      <Field label="System">
        <Select value={systemType} onChange={(e) => setSystemType(e.target.value)}>
          {SYSTEM_TYPES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </Select>
      </Field>
      <Field label="Category">
        <Select value={category} onChange={(e) => setCategory(e.target.value)}>
          {MATERIAL_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </Select>
      </Field>
      <Field label="Unit (raw)">
        <TextInput value={unitRaw} onChange={(e) => setUnitRaw(e.target.value)} />
      </Field>
      <Field label="Unit (normalized)">
        <Select value={unitNormalized} onChange={(e) => setUnitNormalized(e.target.value)}>
          <option value="">— unrecognized —</option>
          {UNITS_OF_MEASURE.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </Select>
      </Field>
      <Field label="Brand (raw)">
        <TextInput value={brandRaw} onChange={(e) => setBrandRaw(e.target.value)} />
      </Field>
      <Field label="Brand (normalized)">
        <TextInput value={brandNormalized} onChange={(e) => setBrandNormalized(e.target.value)} placeholder="— unrecognized —" />
      </Field>
      <Field label="Tier">
        <Select value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="">—</option>
          {MAKE_TIERS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </Select>
      </Field>
      <Field label="Rate kind">
        <Select value={rateKind} onChange={(e) => setRateKind(e.target.value)}>
          {STAGED_RATE_KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </Select>
      </Field>
      <Field label="Sell rate (₹)">
        <TextInput type="number" min={0} value={sellRupees} onChange={(e) => setSellRupees(e.target.value)} />
      </Field>
      <Field label="Buy rate (₹)">
        <TextInput type="number" min={0} value={buyRupees} onChange={(e) => setBuyRupees(e.target.value)} />
      </Field>
      <Field label="Valid from">
        <TextInput type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
      </Field>
      <div className="md:col-span-2">
        <label className="mb-1 flex items-center gap-2 text-sm font-medium text-[var(--pebble-ink)]">
          <input type="checkbox" checked={hasInstallRate} onChange={(e) => setHasInstallRate(e.target.checked)} />
          Install rate observed
        </label>
        {hasInstallRate ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Install rate (₹)">
              <TextInput type="number" min={0} value={installRupees} onChange={(e) => setInstallRupees(e.target.value)} />
            </Field>
            <Field label="Install unit">
              <Select value={installUnit} onChange={(e) => setInstallUnit(e.target.value)}>
                {INSTALL_RATE_UNITS.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}
      </div>
      <div className="md:col-span-2">
        <Field label="Spec summary">
          <Textarea rows={2} value={specSummary} onChange={(e) => setSpecSummary(e.target.value)} />
        </Field>
      </div>
    </div>
  );
}

function PricePointForm({ proposed, onChange }: { proposed: Json; onChange: (v: Json) => void }) {
  const brandName = obj(proposed.brandName);
  const [materialCode, setMaterialCode] = useState(str(proposed.materialCode));
  const [brandRaw, setBrandRaw] = useState(str(brandName.raw));
  const [brandNormalized, setBrandNormalized] = useState(str(brandName.normalized));
  const [sellRupees, setSellRupees] = useState(numStr(proposed.sellRupees));
  const [buyRupees, setBuyRupees] = useState(numStr(proposed.buyRupees));
  const [rateKind, setRateKind] = useState(str(proposed.rateKind, "UNKNOWN"));
  const [validFrom, setValidFrom] = useState(isoToDateInput(proposed.validFromISO));

  useEffect(() => {
    onChange({
      ...proposed,
      materialCode,
      brandName: { raw: brandRaw, normalized: brandNormalized || null },
      sellRupees: sellRupees === "" ? 0 : Number(sellRupees),
      buyRupees: buyRupees === "" ? null : Number(buyRupees),
      rateKind,
      validFromISO: dateInputToIso(validFrom),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialCode, brandRaw, brandNormalized, sellRupees, buyRupees, rateKind, validFrom]);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Field label="Material code">
        <TextInput id={FIRST_FIELD_ID} value={materialCode} onChange={(e) => setMaterialCode(e.target.value)} />
      </Field>
      <Field label="Rate kind">
        <Select value={rateKind} onChange={(e) => setRateKind(e.target.value)}>
          {STAGED_RATE_KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </Select>
      </Field>
      <Field label="Brand (raw)">
        <TextInput value={brandRaw} onChange={(e) => setBrandRaw(e.target.value)} />
      </Field>
      <Field label="Brand (normalized)">
        <TextInput value={brandNormalized} onChange={(e) => setBrandNormalized(e.target.value)} placeholder="— unrecognized —" />
      </Field>
      <Field label="Sell rate (₹)">
        <TextInput type="number" min={0} value={sellRupees} onChange={(e) => setSellRupees(e.target.value)} />
      </Field>
      <Field label="Buy rate (₹)">
        <TextInput type="number" min={0} value={buyRupees} onChange={(e) => setBuyRupees(e.target.value)} />
      </Field>
      <Field label="Valid from">
        <TextInput type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
      </Field>
    </div>
  );
}

function MakeLinkForm({ proposed, onChange }: { proposed: Json; onChange: (v: Json) => void }) {
  const brandName = obj(proposed.brandName);
  const [materialCode, setMaterialCode] = useState(str(proposed.materialCode));
  const [brandRaw, setBrandRaw] = useState(str(brandName.raw));
  const [brandNormalized, setBrandNormalized] = useState(str(brandName.normalized));
  const [tier, setTier] = useState(str(proposed.tier));

  useEffect(() => {
    onChange({
      ...proposed,
      materialCode,
      brandName: { raw: brandRaw, normalized: brandNormalized || null },
      tier: tier || null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialCode, brandRaw, brandNormalized, tier]);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Field label="Material code">
        <TextInput id={FIRST_FIELD_ID} value={materialCode} onChange={(e) => setMaterialCode(e.target.value)} />
      </Field>
      <Field label="Tier">
        <Select value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="">—</option>
          {MAKE_TIERS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </Select>
      </Field>
      <Field label="Brand (raw)">
        <TextInput value={brandRaw} onChange={(e) => setBrandRaw(e.target.value)} />
      </Field>
      <Field label="Brand (normalized)">
        <TextInput value={brandNormalized} onChange={(e) => setBrandNormalized(e.target.value)} placeholder="— unrecognized —" />
      </Field>
    </div>
  );
}

function InstallRateForm({ proposed, onChange }: { proposed: Json; onChange: (v: Json) => void }) {
  const [materialCode, setMaterialCode] = useState(str(proposed.materialCode));
  const [systemType, setSystemType] = useState(str(proposed.systemType, SYSTEM_TYPES[0]));
  const [unit, setUnit] = useState(str(proposed.unit, INSTALL_RATE_UNITS[0]));
  const [rupees, setRupees] = useState(numStr(proposed.rupees));

  useEffect(() => {
    onChange({
      ...proposed,
      materialCode: materialCode || null,
      systemType,
      unit,
      rupees: rupees === "" ? 0 : Number(rupees),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialCode, systemType, unit, rupees]);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Field label="Linked material code (optional)">
        <TextInput id={FIRST_FIELD_ID} value={materialCode} onChange={(e) => setMaterialCode(e.target.value)} placeholder="system-generic if blank" />
      </Field>
      <Field label="System">
        <Select value={systemType} onChange={(e) => setSystemType(e.target.value)}>
          {SYSTEM_TYPES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </Select>
      </Field>
      <Field label="Unit">
        <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
          {INSTALL_RATE_UNITS.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </Select>
      </Field>
      <Field label="Rate (₹)">
        <TextInput type="number" min={0} value={rupees} onChange={(e) => setRupees(e.target.value)} />
      </Field>
    </div>
  );
}
