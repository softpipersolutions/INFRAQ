import type {
  ApplicableStandard,
  BuildingType,
  EstimateTotals,
  PricedLine,
  SitcStatus,
  SystemType,
} from "@pebble/shared";
import { ESTIMATE_VALIDITY_DAYS, sumPaise } from "@pebble/shared";
import {
  GREENBERG_MONOGRAM_DATA_URI,
  GREENBERG_WORDMARK_DATA_URI,
} from "./assets/logo";

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
  /** Brand strapline printed under the wordmark (e.g. "Exploring Synergy, Empowering Lives!"). */
  tagline?: string | null;
  /**
   * Square brand mark as a data URI (rendered top-left of the letterhead).
   * Data URIs keep the template a pure function — no file/network I/O at
   * render time. `null`/absent falls back to the text-only letterhead.
   */
  logoDataUri?: string | null;
  /** Wordmark image as a data URI (rendered beside the mark); optional. */
  wordmarkDataUri?: string | null;
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
 * Greenberg house defaults — the *real* letterhead of the current legal entity.
 *
 * Sources (2026-07): GST Registration Certificate Form REG-06 (GSTIN, legal
 * name, principal place of business; effective 15/06/2025) and the official
 * company letterhead (brand marks, tagline, contact block). Bank block carried
 * from the latest issued proposals (FF-149, Dec 2025). Every field remains
 * overridable via `CompanyConfig` (see the entity-rename note above).
 */
export const DEFAULT_COMPANY: CompanyConfig = {
  name: "Greenberg Engineering Private Limited",
  tagline: "Exploring Synergy, Empowering Lives!",
  logoDataUri: GREENBERG_MONOGRAM_DATA_URI,
  wordmarkDataUri: GREENBERG_WORDMARK_DATA_URI,
  addressLines: [
    "5/178, Vikas Nagar Thana Road, Vikas Nagar",
    "Lucknow, Uttar Pradesh 226022",
  ],
  gstin: "09AAMCG0423A1Z3",
  phone: "+91 9555 820 193",
  email: "greenberg.connect@gmail.com",
  website: "www.greenberg.engineering",
  bank: {
    bankName: "HDFC Bank",
    accountName: "Greenberg Enterprises",
    accountNumber: "50200078849625",
    ifsc: "HDFC0004492",
    branch: "Vikas Nagar, Lucknow",
  },
  signatoryName: "Devansh Gulati",
  signatoryCredentials:
    "IDip NEBOSH (M.Tech Env) | BV Certified IMS (9001, 14001, 18001) Internal Auditor | UK NFPA CFPS Trained",
  termsAndConditions: DEFAULT_TERMS(),
};

/**
 * The house 10-point Terms & Conditions, transcribed verbatim from the latest
 * issued proposals (FF-149, Dec 2025). Returned by a factory (not a shared
 * mutable array) so every `CompanyConfig` gets an independent copy. Callers may
 * replace the list wholesale via `CompanyConfig.termsAndConditions`.
 */
export function DEFAULT_TERMS(): string[] {
  return [
    "Payment Plan — (a) 15% of the total contract value will be charged as advance for MOBILIZATION; " +
      "(b) Interim Invoicing: 65% Delivery & Verification | 20% Erection & Verification | " +
      "10% Testing & Verification | 5% Handover & Verification; (c) GST @ 18%.",
    "Estimated Duration of works — Supply Chain will be designed and managed as per the approved Project Schedule: To be discussed.",
    "Any regulatory / market price changes affecting the Contract Cost will be duly communicated to the Client; " +
      "Contractor shall clarify for a revision to accommodate the price change.",
    "Any change in quantities as mentioned above will be duly notified prior to procurement.",
    "This rate list shall apply to actual quantities consumed at site for fulfilling the desired mission and " +
      "Invoicing will be done based on the same.",
    "Provision of Overhead & Underground tanks will be under the Client's scope.",
    "Provision of electricity will be under the Client's scope.",
    "Client to allow team to stay at the under-construction premises for swift execution.",
    "Rates and Payment Terms are negotiable.",
    "This quotation is valid for 7 days only from the date of issue due to constant fluctuations of raw material prices.",
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
