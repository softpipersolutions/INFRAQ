export { formatINR } from "@pebble/shared";

/** Human date-time for audit/list rows. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRatio(ratio: number | null): string {
  return ratio === null ? "—" : ratio.toFixed(4);
}
