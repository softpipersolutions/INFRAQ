import type { PricedLine } from "@pebble/shared";

/**
 * Version compare — a pure join on line_uid (no diff is ever stored). Used by
 * the review UI to show what changed between two estimate versions.
 */

export interface FieldDelta {
  field: string;
  before: number | string | null;
  after: number | string | null;
}

export interface ChangedLine {
  lineUid: string;
  before: PricedLine;
  after: PricedLine;
  deltas: FieldDelta[];
}

export interface VersionDiff {
  added: PricedLine[];
  removed: PricedLine[];
  changed: ChangedLine[];
  unchanged: PricedLine[];
}

/** Fields compared when detecting a change between two versions of a line. */
const COMPARED_FIELDS = [
  "qty",
  "makeCode",
  "brandName",
  "description",
  "supplyRatePaise",
  "installRatePaise",
  "sitcRatePaise",
  "supplyAmountPaise",
  "installAmountPaise",
  "lineAmountPaise",
  "unit",
] as const satisfies readonly (keyof PricedLine)[];

/** Diff two versions' lines by line_uid (A = older/base, B = newer). */
export function diffVersions(a: readonly PricedLine[], b: readonly PricedLine[]): VersionDiff {
  const aByUid = new Map(a.map((l) => [l.lineUid, l]));
  const bByUid = new Map(b.map((l) => [l.lineUid, l]));

  const added: PricedLine[] = [];
  const removed: PricedLine[] = [];
  const changed: ChangedLine[] = [];
  const unchanged: PricedLine[] = [];

  for (const bLine of b) {
    const aLine = aByUid.get(bLine.lineUid);
    if (!aLine) {
      added.push(bLine);
      continue;
    }
    const deltas: FieldDelta[] = [];
    for (const field of COMPARED_FIELDS) {
      const before = aLine[field] as number | string | null;
      const after = bLine[field] as number | string | null;
      if (before !== after) deltas.push({ field, before, after });
    }
    if (deltas.length > 0) changed.push({ lineUid: bLine.lineUid, before: aLine, after: bLine, deltas });
    else unchanged.push(bLine);
  }
  for (const aLine of a) {
    if (!bByUid.has(aLine.lineUid)) removed.push(aLine);
  }

  return { added, removed, changed, unchanged };
}
