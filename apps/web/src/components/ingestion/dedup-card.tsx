"use client";

import { Badge, Button, Card } from "@/components/ui";

export interface DedupSuggestion {
  materialCode: string;
  materialName: string;
  similarity: number;
}

/** Dedup similarity at/above which the queue treats a proposal as a likely duplicate. */
export const DEDUP_SIMILARITY_THRESHOLD = 0.82;

/**
 * Presentational dedup card for the queue's material-bundle detail pane — the
 * data (trgm candidates for the current item's material name) is fetched by
 * the parent so it can also drive the "m" merge shortcut and the Shift+A bulk
 * eligibility check without duplicating the query.
 */
export function DedupCard({
  materialName,
  suggestions,
  isLoading,
  onMergeInto,
}: {
  materialName: string | null;
  suggestions: DedupSuggestion[] | undefined;
  isLoading: boolean;
  onMergeInto: (materialCode: string) => void;
}) {
  if (!materialName) return null;
  return (
    <Card className="p-4">
      <div className="mb-2 text-sm font-semibold">Possible duplicates</div>
      {isLoading ? (
        <div className="text-sm text-[var(--pebble-muted)]">Checking…</div>
      ) : !suggestions || suggestions.length === 0 ? (
        <div className="text-sm text-[var(--pebble-muted)]">No similar materials found.</div>
      ) : (
        <ul className="space-y-2">
          {suggestions.map((c) => (
            <li key={c.materialCode} className="flex items-center justify-between gap-2 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium">{c.materialName}</div>
                <div className="font-mono text-xs text-[var(--pebble-muted)]">{c.materialCode}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={c.similarity >= DEDUP_SIMILARITY_THRESHOLD ? "amber" : "neutral"}>
                  {Math.round(c.similarity * 100)}%
                </Badge>
                <Button variant="secondary" onClick={() => onMergeInto(c.materialCode)}>
                  Merge into this
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
