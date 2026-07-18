import "server-only";

import {
  getEnquiry,
  loadMasterSnapshot,
  persistGeneratedEstimate,
  type Db,
} from "@pebble/db";
import { generateEstimate, type GenerationInput } from "@pebble/engines";
import type { SystemType } from "@pebble/shared";

/**
 * Deterministic generation service.
 *
 * Loads the enquiry + a resolved master snapshot, runs the pure engines
 * (B.01 → B.03 → margin → totals), then persists estimate + LOCKED v1 + lines
 * with the full generation audit trail. LLMs never touch this path.
 */
export async function generateForEnquiry(
  db: Db,
  enquiryId: string,
  actor: string,
  actorRole: string | null = null,
): Promise<string> {
  const enquiry = await getEnquiry(db, enquiryId);
  if (!enquiry) throw new Error(`Enquiry ${enquiryId} not found`);

  const snapshot = await loadMasterSnapshot(db);

  const input: GenerationInput = {
    buildingType: enquiry.buildingType,
    floorsAbove: enquiry.floorsAbove,
    floorAreaSqm: enquiry.floorAreaSqm,
    systemsRequired: enquiry.systemsRequired as SystemType[],
    makePreference: enquiry.makePreference,
    applicableStandard: enquiry.applicableStandard,
    projectTier: enquiry.projectTier,
  };

  const generation = generateEstimate(input, snapshot);

  const { estimateId } = await persistGeneratedEstimate(db, {
    enquiryId,
    generation,
    actor,
    actorRole,
  });

  return estimateId;
}
