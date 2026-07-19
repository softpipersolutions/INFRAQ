import "server-only";

import {
  createEnquiry,
  getEnquiry,
  loadMasterSnapshot,
  persistGeneratedEstimate,
  type Db,
} from "@pebble/db";
import { generateEstimate, type GenerationInput } from "@pebble/engines";
import type { EnquiryInput, SystemType } from "@pebble/shared";

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

/**
 * The one validated create+generate path shared by the enquiry form
 * (`enquiry.create`) and chat confirmation (`chat.confirmEnquiry`): persist the
 * A.08 enquiry (ENQ_CREATED audit) then run deterministic generation into a
 * LOCKED v1. Both callers pass an `EnquiryInput` already parsed by the SAME
 * `enquiryInputSchema`, so form and chat can never diverge.
 */
export async function createEnquiryAndGenerate(
  db: Db,
  input: EnquiryInput,
  actor: string,
  actorRole: string | null = null,
): Promise<{ enquiryId: string; estimateId: string }> {
  const enquiry = await createEnquiry(db, input, actor);
  const estimateId = await generateForEnquiry(db, enquiry.enquiryId, actor, actorRole);
  return { enquiryId: enquiry.enquiryId, estimateId };
}
