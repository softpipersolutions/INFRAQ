import type {
  ApplicableStandard,
  ExprContext,
  MakePreference,
  SystemType,
} from "@pebble/shared";

/**
 * The enquiry-derived inputs the engines need. Maps 1:1 from A.08 EnquiryInput.
 * Money never appears here — the engines fetch rates from the MasterSnapshot.
 */
export interface GenerationInput {
  buildingType: string;
  floorsAbove: number;
  floorAreaSqm: number;
  /** Requested systems (A.08 excludes "Common"); one BOM section per system. */
  systemsRequired: SystemType[];
  makePreference: MakePreference;
  applicableStandard: ApplicableStandard;
  projectTier: number;
}

/** Effective floor area basis: at least one floor is always counted. */
export function totalAreaSqm(input: GenerationInput): number {
  return Math.max(input.floorsAbove, 1) * input.floorAreaSqm;
}

/** Build the rule-evaluation context for one system of an enquiry (spec A.06). */
export function buildExprContext(input: GenerationInput, system: SystemType): ExprContext {
  return {
    building_type: input.buildingType,
    floors_above: input.floorsAbove,
    floor_area_sqm: input.floorAreaSqm,
    total_area_sqm: totalAreaSqm(input),
    system,
    make_preference: input.makePreference,
    applicable_standard: input.applicableStandard,
    project_tier: input.projectTier,
  };
}
