import { z } from "zod";
import {
  APPLICABLE_STANDARDS,
  BUILDING_TYPES,
  ENQUIRY_SOURCES,
  MAKE_PREFERENCES,
  REQUESTABLE_SYSTEM_TYPES,
} from "./enums";

/**
 * A.08 Enquiry Input Schema — the standardized record that triggers the
 * generation engine. Every estimate must trace back to a valid enquiry.
 */
export const enquiryInputSchema = z.object({
  clientName: z.string().min(1).max(200),
  projectName: z.string().min(1).max(200),
  buildingType: z.enum(BUILDING_TYPES),
  floorsAbove: z.number().int().min(0).max(200),
  floorAreaSqm: z.number().positive().max(1_000_000),
  systemsRequired: z
    .array(z.enum(REQUESTABLE_SYSTEM_TYPES))
    .min(1)
    .refine((arr) => new Set(arr).size === arr.length, "Duplicate systems"),
  makePreference: z.enum(MAKE_PREFERENCES),
  applicableStandard: z.enum(APPLICABLE_STANDARDS).default("IS"),
  /** 1–4, auto-suggested from estimated value; manually editable. */
  projectTier: z.number().int().min(1).max(4),
  clientEmail: z.string().email().nullable().optional().default(null),
  clientPhone: z.string().max(20).nullable().optional().default(null),
  notes: z.string().max(4000).nullable().optional().default(null),
  source: z.enum(ENQUIRY_SOURCES).default("form"),
});
export type EnquiryInput = z.infer<typeof enquiryInputSchema>;

/** A persisted enquiry (input + identity). */
export const enquirySchema = enquiryInputSchema.extend({
  enquiryId: z.string(), // GBE-ENQ-2025-001
  createdBy: z.string(),
  createdAt: z.string(),
});
export type Enquiry = z.infer<typeof enquirySchema>;
