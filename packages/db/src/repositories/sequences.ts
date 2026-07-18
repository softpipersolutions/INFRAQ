import {
  ENQUIRY_ID_PREFIX,
  ESTIMATE_ID_PREFIX,
  formatSequentialId,
} from "@pebble/shared";
import { sql } from "drizzle-orm";
import type { Db } from "../client";
import { sequences } from "../schema";

/**
 * Atomic per-year business-id counters. The INSERT … ON CONFLICT DO UPDATE …
 * RETURNING pattern increments and reads in a single statement, so concurrent
 * generations can never collide on GBE-ENQ-2025-001 style ids.
 */
export async function nextSequenceValue(db: Db, name: string, year: number): Promise<number> {
  const rows = await db
    .insert(sequences)
    .values({ name, year, value: 1 })
    .onConflictDoUpdate({
      target: [sequences.name, sequences.year],
      set: { value: sql`${sequences.value} + 1` },
    })
    .returning({ value: sequences.value });
  const value = rows[0]?.value;
  if (value === undefined) throw new Error(`Sequence ${name}/${year} returned no value`);
  return value;
}

export async function nextEnquiryId(db: Db, year: number): Promise<string> {
  const seq = await nextSequenceValue(db, "enquiry", year);
  return formatSequentialId(ENQUIRY_ID_PREFIX, year, seq);
}

export async function nextEstimateId(db: Db, year: number): Promise<string> {
  const seq = await nextSequenceValue(db, "estimate", year);
  return formatSequentialId(ESTIMATE_ID_PREFIX, year, seq);
}
