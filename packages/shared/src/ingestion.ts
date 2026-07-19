import { z } from "zod";
import {
  MAKE_TIERS,
  SYSTEM_TYPES,
  UNITS_OF_MEASURE,
  type SystemType,
  type TargetMaster,
} from "./enums";

/**
 * Phase B ingestion contracts (spec section E). An extraction run proposes rows
 * as `staged_records`; each staged row carries a versioned JSON payload plus a
 * source locator, and — once a human approves it — a source provenance stamp is
 * written onto the committed master row. These are the FROZEN wire shapes shared
 * by the worker (writer), the web verification queue (reader) and the db commit
 * repository: payloads are additive-only and carry an explicit payloadVersion so
 * a v2 payload can be introduced without breaking v1 readers.
 *
 * Monetary fields here are raw RUPEES as read from the source document (numbers
 * or null when the document is silent); the db commit layer converts to the
 * integer-paise / NUMERIC(14,2) discipline of @pebble/shared money utils.
 */

/** Kind of rate a staged price/install line represents. */
export const STAGED_RATE_KINDS = ["SITC", "SUPPLY", "INSTALL", "UNKNOWN"] as const;
export type StagedRateKind = (typeof STAGED_RATE_KINDS)[number];

/**
 * Where in a source document a proposal came from. Every field is optional but
 * at least one must be present, so a reviewer can always jump back to the source
 * (a PDF page range, an Excel sheet+row, or a printed Sl. No.).
 */
export const sourceLocatorSchema = z
  .object({
    page: z.number().int().positive().optional(),
    sheet: z.string().min(1).optional(),
    row: z.number().int().optional(),
    slNo: z.string().min(1).optional(),
    pageStart: z.number().int().positive().optional(),
    pageEnd: z.number().int().positive().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "sourceLocator requires at least one of page/sheet/row/slNo/pageStart/pageEnd",
  });
export type SourceLocator = z.infer<typeof sourceLocatorSchema>;

/**
 * Provenance stamp written onto a master row (makes/prices/install_rates —
 * materials already carries it) when a staged_record is committed. It is the
 * back-pointer from clean master data to the exact document, run and staged row
 * it was derived from.
 */
export const sourceProvenanceSchema = z.object({
  sourceDocumentId: z.string().min(1),
  extractionRunId: z.string().min(1),
  stagedRecordId: z.string().min(1),
  filename: z.string().min(1),
  page: z.number().int().positive().optional(),
  sheet: z.string().min(1).optional(),
  row: z.number().int().optional(),
  promptVersion: z.string().min(1),
  committedBy: z.string().min(1),
  committedAt: z.string().datetime(),
});
export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;

/** A raw make paired with its canonical brand (null = unrecognized, needs review). */
const brandRefSchema = z.object({
  raw: z.string().min(1),
  normalized: z.string().min(1).nullable(),
});

/** A raw unit paired with its canonical UnitOfMeasure (null = unrecognized). */
const unitRefSchema = z.object({
  raw: z.string().min(1),
  normalized: z.enum(UNITS_OF_MEASURE).nullable(),
});

/**
 * A NEW material proposal — a material that does not yet exist in the register,
 * bundled with the make, price and (optional) install rate observed alongside
 * it in the source line. materialCode is a PROPOSED code (see
 * proposeMaterialCode); the reviewer may accept or replace it before commit.
 */
export const stagedMaterialBundleSchema = z.object({
  payloadVersion: z.literal(1),
  material: z.object({
    materialCode: z.string().min(1),
    materialName: z.string().min(1),
    systemType: z.enum(SYSTEM_TYPES),
    category: z.string().min(1),
    unitOfMeasure: unitRefSchema,
    specSummary: z.string().optional(),
  }),
  make: z.object({
    brandName: brandRefSchema,
    tier: z.enum(MAKE_TIERS).nullable().optional(),
  }),
  price: z.object({
    sellRupees: z.number().nonnegative().nullable(),
    buyRupees: z.number().nonnegative().nullable().optional(),
    rateKind: z.enum(STAGED_RATE_KINDS),
    validFromISO: z.string().datetime().nullable(),
  }),
  installRate: z
    .object({
      rupees: z.number().nonnegative(),
      unit: z.string().min(1),
    })
    .nullable()
    .optional(),
  sourceText: z.string().min(1),
});
export type StagedMaterialBundle = z.infer<typeof stagedMaterialBundleSchema>;

/** A price point for an EXISTING (materialCode, make) pair. */
export const stagedPricePointSchema = z.object({
  payloadVersion: z.literal(1),
  materialCode: z.string().min(1),
  brandName: brandRefSchema,
  sellRupees: z.number().nonnegative(),
  buyRupees: z.number().nonnegative().nullable().optional(),
  rateKind: z.enum(STAGED_RATE_KINDS),
  validFromISO: z.string().datetime().nullable(),
  sourceText: z.string().min(1),
});
export type StagedPricePoint = z.infer<typeof stagedPricePointSchema>;

/** A make (brand) link for an EXISTING material — no price attached. */
export const stagedMakeLinkSchema = z.object({
  payloadVersion: z.literal(1),
  materialCode: z.string().min(1),
  brandName: brandRefSchema,
  tier: z.enum(MAKE_TIERS).nullable().optional(),
  sourceText: z.string().min(1),
});
export type StagedMakeLink = z.infer<typeof stagedMakeLinkSchema>;

/** An installation-rate proposal, optionally linked to a specific material. */
export const stagedInstallRateSchema = z.object({
  payloadVersion: z.literal(1),
  materialCode: z.string().min(1).nullable().optional(),
  systemType: z.enum(SYSTEM_TYPES),
  unit: z.string().min(1),
  rupees: z.number().nonnegative(),
  sourceText: z.string().min(1),
});
export type StagedInstallRate = z.infer<typeof stagedInstallRateSchema>;

/** Union of every staged payload shape. */
export type StagedPayload =
  | StagedMaterialBundle
  | StagedPricePoint
  | StagedMakeLink
  | StagedInstallRate;

/** The zod schema that validates a staged_record whose target_master is `target`. */
export function stagedPayloadSchemaFor(target: TargetMaster) {
  switch (target) {
    case "materials":
      return stagedMaterialBundleSchema;
    case "makes":
      return stagedMakeLinkSchema;
    case "prices":
      return stagedPricePointSchema;
    case "install_rates":
      return stagedInstallRateSchema;
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unknown target master: ${String(_exhaustive)}`);
    }
  }
}

/** Material_code prefix per fire-safety system (spec A.01 house convention). */
const SYSTEM_CODE_PREFIXES: Record<SystemType, string> = {
  FAS: "FAS",
  Hydrant: "HYD",
  Sprinkler: "SPR",
  Extinguisher: "EXT",
  Suppression: "SUP",
  Common: "COM",
};

/**
 * House abbreviations for the known material categories (spec A.01). A proposed
 * material_code is `PREFIX-ABBR-NNN` (e.g. "FAS-DET-007"); the ABBR segment is
 * derived from the category. Categories outside this table fall back to the
 * first alphanumeric token of the category, uppercased and capped at 4 chars.
 */
const CATEGORY_CODE_ABBREVS: Record<string, string> = {
  Detector: "DET",
  Panel: "PNL",
  Cable: "CBL",
  Pipe: "PIPE",
  Valve: "VLV",
  Pump: "PUMP",
  Fitting: "FIT",
  Extinguisher: "EXTG",
  Accessory: "ACC",
  Signage: "SIGN",
};

function categoryAbbrev(category: string): string {
  const known = CATEGORY_CODE_ABBREVS[category.trim()];
  if (known !== undefined) return known;
  const token = category
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t.length > 0)[0];
  return (token ?? "GEN").toUpperCase().slice(0, 4);
}

/**
 * Propose a new material_code as `PREFIX-ABBR-NNN`, continuing the sequence past
 * the highest NNN already present for that prefix+abbrev so a proposal never
 * reuses or collides with a committed code. The reviewer may override it.
 */
export function proposeMaterialCode(
  systemType: SystemType,
  category: string,
  existingCodes: ReadonlySet<string>,
): string {
  const stem = `${SYSTEM_CODE_PREFIXES[systemType]}-${categoryAbbrev(category)}-`;
  let maxSeq = 0;
  for (const code of existingCodes) {
    if (!code.startsWith(stem)) continue;
    const tail = code.slice(stem.length);
    if (/^\d+$/.test(tail)) {
      const n = Number.parseInt(tail, 10);
      if (n > maxSeq) maxSeq = n;
    }
  }
  let seq = maxSeq + 1;
  let candidate = `${stem}${String(seq).padStart(3, "0")}`;
  while (existingCodes.has(candidate)) {
    seq += 1;
    candidate = `${stem}${String(seq).padStart(3, "0")}`;
  }
  return candidate;
}
