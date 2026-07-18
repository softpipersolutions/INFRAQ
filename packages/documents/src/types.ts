import type {
  ApplicableStandard,
  BuildingType,
  EstimateTotals,
  PricedLine,
  SitcStatus,
  SystemType,
} from "@pebble/shared";
import { ESTIMATE_VALIDITY_DAYS, sumPaise } from "@pebble/shared";

/**
 * Format A is the single professional Greenberg fire-safety BOQ/quotation that
 * the historical corpus (2022–2026 proposals) converged on. Both renderers —
 * the HTML→PDF template (`html.ts`) and the Excel workbook (`excel.ts`) — are
 * *pure functions of one immutable input object* so the on-screen preview, the
 * rendered PDF, and the spreadsheet can never disagree. That shared input is
 * `FormatAInput`, defined here.
 *
 * Design decisions worth stating up front:
 *  - **Money is never recomputed.** The engines (B.02/B.03) already produced the
 *    authoritative `EstimateTotals` (integer paise, single rounding point). The
 *    documents layer only *sums per section for display* and *formats* — it
 *    trusts `totals.totalSitcPaise` / `gstPaise` / `grandTotalPaise` verbatim.
 *  - **The letterhead is editable config, not a hard-coded constant.** The 2023
 *    corpus was issued under the predecessor entity "Padmawati Enterprises", so
 *    every company/bank/T&C/signatory field lives in `CompanyConfig`. We ship
 *    sensible Greenberg defaults (`DEFAULT_COMPANY`) but callers may override.
 *  - **Split output modes are anticipated but not built.** Some jobs issue
 *    parallel "Supply Only" + "Labour Charges" documents. v1 only emits the
 *    combined-SITC document; `FormatAInput.mode` reserves the seam so a
 *    `"supplyOnly"` / `"labour"` mode can be added later without a shape change.
 */

/** Output modes the template is structured to support. v1 renders `"combined"`. */
export type FormatAMode = "combined" | "supplyOnly" | "labour";

/** Bank / payment block — appears in the letterhead footer (HDFC from 2024+). */
export interface BankDetails {
  bankName: string;
  accountName: string;
  accountNumber: string;
  ifsc: string;
  branch?: string | null;
}

/**
 * Everything about the *issuing company* that Format A prints: letterhead,
 * payment block, signatory credentials, and the default T&C list. Kept separate
 * from the estimate/project data so a caller can swap letterheads (entity
 * rename, sub-brand, different signatory) without touching the estimate.
 */
export interface CompanyConfig {
  /** Legal / trading name shown in the letterhead. */
  name: string;
  /** One address line per array element (rendered stacked). */
  addressLines: string[];
  /** GST identification number. */
  gstin: string;
  phone: string;
  email: string;
  website?: string | null;
  bank: BankDetails;
  /** Name printed above the signature line. */
  signatoryName: string;
  /** e.g. "NEBOSH / NFPA certified" — printed under the signatory name. */
  signatoryCredentials: string;
  /**
   * The 10-point Terms & Conditions list. Fully overridable; `DEFAULT_TERMS`
   * captures the house defaults (validity, taxes, payment terms, delivery…).
   */
  termsAndConditions: string[];
}

/** Estimate identity + issue metadata (the "header block" top-line fields). */
export interface EstimateMeta {
  /** e.g. `GBE-EST-2025-014`. */
  estimateId: string;
  /** Revision label as a string, e.g. `"R0"`, `"R2"`. */
  revision: string;
  /** ISO date the estimate is issued (YYYY-MM-DD or full ISO timestamp). */
  dateISO: string;
  /** House rule default is 7 days ("raw material price fluctuations"). */
  validityDays: number;
}

/** Client / project fields for the header block (sourced from the enquiry). */
export interface ProjectMeta {
  clientName: string;
  projectName: string;
  /** "Attn:" contact person, when known. */
  attention?: string | null;
  clientEmail?: string | null;
  clientPhone?: string | null;
  buildingType?: BuildingType | null;
  applicableStandard?: ApplicableStandard | null;
}

/**
 * A rendered PART section: all lines of one `SystemType`, its subtotal (exact
 * integer-paise sum of the section's `lineAmountPaise`), and the presentation
 * labels ("PART II", "PORTABLE FIRE EXTINGUISHERS").
 */
export interface FormatASection {
  systemType: SystemType;
  /** e.g. `"PART I"`. */
  partLabel: string;
  /** Human system name, e.g. `"FIRE ALARM SYSTEM"`. */
  systemLabel: string;
  /** Combined label, e.g. `"PART I — FIRE ALARM SYSTEM"`. */
  title: string;
  /** Section lines in `lineOrder`. */
  lines: PricedLine[];
  /** Sum of this section's `lineAmountPaise` (integer paise). */
  subtotalPaise: number;
}

/** The complete, immutable input both Format A renderers consume. */
export interface FormatAInput {
  estimate: EstimateMeta;
  project: ProjectMeta;
  /** Priced lines from the engine (any order — grouped/sorted at render time). */
  lines: PricedLine[];
  /** Authoritative money from the engine — never recomputed here. */
  totals: EstimateTotals;
  /** Issuing-company letterhead/config. */
  company: CompanyConfig;
  /** B.03 blended ratio, when available (SITC / Supply). */
  blendedRatio?: number | null;
  /** B.03 status (PASS / ALERT), when available. */
  sitcStatus?: SitcStatus | null;
  /** v1 always `"combined"`; reserved for future split outputs. */
  mode?: FormatAMode;
}

// ─── Company defaults ───────────────────────────────────────────────────────

/**
 * Greenberg house defaults. These are *defaults*, not the only option — every
 * field is overridable via `CompanyConfig` (see the entity-rename note above).
 */
export const DEFAULT_COMPANY: CompanyConfig = {
  name: "Greenberg Enterprises",
  addressLines: [
    "1st Floor, Vishal Complex, Gomti Nagar",
    "Lucknow, Uttar Pradesh 226010",
  ],
  gstin: "09ABCDE1234F1Z5",
  phone: "+91 98765 43210",
  email: "estimates@greenbergenterprises.in",
  website: "www.greenbergenterprises.in",
  bank: {
    bankName: "HDFC Bank",
    accountName: "Greenberg Enterprises",
    accountNumber: "50200012345678",
    ifsc: "HDFC0001234",
    branch: "Gomti Nagar, Lucknow",
  },
  signatoryName: "For Greenberg Enterprises",
  signatoryCredentials: "NEBOSH / NFPA certified Fire Safety Engineer",
  termsAndConditions: DEFAULT_TERMS(),
};

/**
 * The house 10-point Terms & Conditions. Returned by a factory (not a shared
 * mutable array) so every `CompanyConfig` gets an independent copy. Callers may
 * replace the list wholesale via `CompanyConfig.termsAndConditions`.
 */
export function DEFAULT_TERMS(): string[] {
  return [
    "This estimate is valid for 7 days from the date of issue, subject to fluctuation in raw-material prices thereafter.",
    "Prices quoted are on a SITC (Supply, Installation, Testing & Commissioning) basis unless stated otherwise.",
    "GST @ 18% is charged extra as shown and is payable as applicable at the time of billing.",
    "Payment terms: 50% advance along with the work order, 40% against delivery at site, and 10% after successful testing & commissioning.",
    "Delivery / completion period will be confirmed on receipt of a firm work order and technically-cleared drawings.",
    "Any civil work, scaffolding, shutdown, safe storage at site, and 3-phase power supply are to be provided free of cost by the client.",
    "Items, makes, and quantities not expressly listed in this estimate are excluded and will be charged as extra.",
    "All statutory approvals, NOCs, and liaison charges with the local Fire Department are outside the scope of this estimate.",
    "Materials supplied remain the property of Greenberg Enterprises until payment is received in full.",
    "This quotation is a budgetary estimate; final BOQ and rates are subject to a joint site survey and detailed engineering.",
  ];
}

// ─── Section grouping ───────────────────────────────────────────────────────

/**
 * Canonical, print-facing system names for the PART headings. Kept here (not in
 * shared enums) because it is a documents-presentation concern — the corpus
 * titles systems as full descriptive phrases ("FIRE ALARM SYSTEM"), not codes.
 */
const SYSTEM_LABELS: Record<SystemType, string> = {
  FAS: "FIRE ALARM SYSTEM",
  Hydrant: "FIRE HYDRANT SYSTEM",
  Sprinkler: "SPRINKLER SYSTEM",
  Extinguisher: "PORTABLE FIRE EXTINGUISHERS",
  Suppression: "GAS SUPPRESSION SYSTEM",
  Common: "COMMON / GENERAL ITEMS",
};

/** Roman numeral for a 1-based part index (1 → "I", 4 → "IV", …). */
export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n <= 0) return String(n);
  const table: Array<[number, string]> = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let out = "";
  let rem = n;
  for (const [value, sym] of table) {
    while (rem >= value) {
      out += sym;
      rem -= value;
    }
  }
  return out;
}

/**
 * The display description for a line: the snapshot description with the make /
 * brand appended, matching the corpus convention of embedding the make in the
 * description text ("...Make: Agni Devices"). Returns just the description when
 * no brand is known.
 */
export function lineDescription(line: PricedLine): string {
  const base = line.description.trim();
  if (line.brandName && line.brandName.trim().length > 0) {
    return `${base} — Make: ${line.brandName.trim()}`;
  }
  return base;
}

/**
 * Group priced lines into PART sections, one per `SystemType`. Section order
 * follows each system's *minimum* `sectionOrder` (the engine assigns
 * `sectionOrder` by first appearance); lines within a section are sorted by
 * `lineOrder`. Each section's subtotal is the exact integer-paise sum of its
 * lines' `lineAmountPaise`. Empty systems produce no section.
 */
export function groupLinesIntoSections(lines: PricedLine[]): FormatASection[] {
  const bySystem = new Map<SystemType, PricedLine[]>();
  const minSectionOrder = new Map<SystemType, number>();

  for (const line of lines) {
    const list = bySystem.get(line.systemType);
    if (list) {
      list.push(line);
    } else {
      bySystem.set(line.systemType, [line]);
    }
    const prev = minSectionOrder.get(line.systemType);
    if (prev === undefined || line.sectionOrder < prev) {
      minSectionOrder.set(line.systemType, line.sectionOrder);
    }
  }

  const orderedSystems = [...bySystem.keys()].sort((a, b) => {
    const sa = minSectionOrder.get(a) ?? 0;
    const sb = minSectionOrder.get(b) ?? 0;
    if (sa !== sb) return sa - sb;
    // Stable tiebreak on the enum-derived label for determinism.
    return SYSTEM_LABELS[a] < SYSTEM_LABELS[b] ? -1 : 1;
  });

  return orderedSystems.map((systemType, index) => {
    const sectionLines = [...(bySystem.get(systemType) ?? [])].sort(
      (a, b) => a.lineOrder - b.lineOrder,
    );
    const partLabel = `PART ${toRoman(index + 1)}`;
    const systemLabel = SYSTEM_LABELS[systemType];
    return {
      systemType,
      partLabel,
      systemLabel,
      title: `${partLabel} — ${systemLabel}`,
      lines: sectionLines,
      subtotalPaise: sumPaise(
        sectionLines.map((l) => l.lineAmountPaise),
        `section ${systemType} subtotal`,
      ),
    };
  });
}

// ─── FormatAInput builder ───────────────────────────────────────────────────

/**
 * The enquiry-shaped fields Format A needs. Accepts the full `@pebble/shared`
 * `Enquiry`/`EnquiryInput` (structural subset) or a hand-built object.
 */
export interface FormatAProjectSource {
  clientName: string;
  projectName: string;
  clientEmail?: string | null;
  clientPhone?: string | null;
  buildingType?: BuildingType | null;
  applicableStandard?: ApplicableStandard | null;
  /** Optional "Attn:" contact override (falls back to `clientName`). */
  attention?: string | null;
}

/** Parts a caller assembles a `FormatAInput` from. */
export interface BuildFormatAInputArgs {
  estimateId: string;
  /** Defaults to `"R0"`. */
  revision?: string;
  /** Defaults to today (caller-supplied ISO recommended for determinism). */
  dateISO?: string;
  /** Defaults to `ESTIMATE_VALIDITY_DAYS` (7). */
  validityDays?: number;
  /** Enquiry / project + client fields. */
  project: FormatAProjectSource;
  lines: PricedLine[];
  totals: EstimateTotals;
  blendedRatio?: number | null;
  sitcStatus?: SitcStatus | null;
  /** Full or partial company override; merged over `DEFAULT_COMPANY`. */
  company?: Partial<CompanyConfig>;
  mode?: FormatAMode;
}

/**
 * Assemble a `FormatAInput` from its parts, applying house defaults for the
 * issuing company, revision, validity, and date. A partial `company` override
 * is shallow-merged over `DEFAULT_COMPANY` (with a nested merge for `bank`) so
 * callers can, e.g., swap only the signatory without restating the address.
 */
export function buildFormatAInput(args: BuildFormatAInputArgs): FormatAInput {
  const company: CompanyConfig = {
    ...DEFAULT_COMPANY,
    ...args.company,
    bank: { ...DEFAULT_COMPANY.bank, ...(args.company?.bank ?? {}) },
    termsAndConditions:
      args.company?.termsAndConditions ?? DEFAULT_COMPANY.termsAndConditions,
  };

  return {
    estimate: {
      estimateId: args.estimateId,
      revision: args.revision ?? "R0",
      dateISO: args.dateISO ?? new Date().toISOString().slice(0, 10),
      validityDays: args.validityDays ?? ESTIMATE_VALIDITY_DAYS,
    },
    project: {
      clientName: args.project.clientName,
      projectName: args.project.projectName,
      attention: args.project.attention ?? args.project.clientName,
      clientEmail: args.project.clientEmail ?? null,
      clientPhone: args.project.clientPhone ?? null,
      buildingType: args.project.buildingType ?? null,
      applicableStandard: args.project.applicableStandard ?? null,
    },
    lines: args.lines,
    totals: args.totals,
    blendedRatio: args.blendedRatio ?? args.totals.blendedRatio ?? null,
    sitcStatus: args.sitcStatus ?? null,
    company,
    mode: args.mode ?? "combined",
  };
}
