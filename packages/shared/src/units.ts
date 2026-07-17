import type { UnitOfMeasure } from "./enums";

/**
 * Unit canonicalization map — every variant observed in the 2022–2026
 * historical corpus (PDF proposals + DSR-style Excel estimates) maps to one
 * canonical UnitOfMeasure. Extend the OBSERVED_UNIT_ALIASES table as ingestion
 * meets new variants; ingestion must never write a non-canonical unit.
 */
const OBSERVED_UNIT_ALIASES: Record<string, UnitOfMeasure> = {
  // No.
  "no": "No.", "no.": "No.", "nos": "No.", "nos.": "No.", "number": "No.",
  "num": "No.", "pc": "No.", "pcs": "No.", "pcs.": "No.", "piece": "No.",
  "pieces": "No.", "each": "No.", "ea": "No.", "unit": "No.", "units": "No.",
  "point": "No.", "points": "No.",
  // Metre
  "m": "Metre", "mt": "Metre", "mtr": "Metre", "mtrs": "Metre", "mtr.": "Metre",
  "meter": "Metre", "meters": "Metre", "metre": "Metre", "metres": "Metre",
  "rmt": "Metre", "rm": "Metre", "rmtr": "Metre", "running metre": "Metre",
  "running meter": "Metre",
  // Set
  "set": "Set", "sets": "Set", "set.": "Set", "pair": "Set", "pairs": "Set",
  // Kg
  "kg": "Kg", "kgs": "Kg", "kg.": "Kg", "kgs.": "Kg", "kilogram": "Kg",
  "kilograms": "Kg",
  // Litre
  "l": "Litre", "ltr": "Litre", "ltrs": "Litre", "litre": "Litre",
  "litres": "Litre", "liter": "Litre", "liters": "Litre",
  // Lot
  "lot": "Lot", "lots": "Lot", "ls": "Lot", "l.s.": "Lot", "l.s": "Lot",
  "lump sum": "Lot", "lumpsum": "Lot", "lump-sum": "Lot", "job": "Lot",
  "jobs": "Lot",
  // Man-day
  "man-day": "Man-day", "man-days": "Man-day", "manday": "Man-day",
  "mandays": "Man-day", "man day": "Man-day", "man days": "Man-day",
  "md": "Man-day",
};

export class UnitNormalizationError extends Error {
  constructor(public readonly raw: string) {
    super(`Unrecognized unit of measure: "${raw}"`);
  }
}

/** Normalize a raw unit string; returns null when unrecognized. */
export function tryNormalizeUnit(raw: string): UnitOfMeasure | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return OBSERVED_UNIT_ALIASES[key] ?? null;
}

/** Normalize a raw unit string; throws UnitNormalizationError when unrecognized. */
export function normalizeUnit(raw: string): UnitOfMeasure {
  const unit = tryNormalizeUnit(raw);
  if (unit === null) throw new UnitNormalizationError(raw);
  return unit;
}
