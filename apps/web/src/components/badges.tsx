import { SITC_MAX_RATIO, SITC_MIN_RATIO } from "@pebble/shared";
import { Badge } from "./ui";

/** SITC PASS/ALERT badge with the blended ratio vs the 1.35–1.51 band. */
export function SitcBadge({
  status,
  ratio,
}: {
  status: string | null;
  ratio: number | null;
}) {
  if (!status) return <Badge tone="neutral">SITC —</Badge>;
  const ratioLabel = ratio === null ? "n/a" : ratio.toFixed(4);
  if (status === "PASS") {
    return (
      <Badge tone="success">
        SITC PASS · {ratioLabel} (band {SITC_MIN_RATIO}–{SITC_MAX_RATIO})
      </Badge>
    );
  }
  return (
    <Badge tone="danger">
      SITC ALERT · {ratioLabel} outside {SITC_MIN_RATIO}–{SITC_MAX_RATIO}
    </Badge>
  );
}

/** Margin OK / BELOW_FLOOR badge with the required authority when below. */
export function MarginBadge({
  status,
  marginPct,
  requiredAuthority,
}: {
  status: string | null;
  marginPct: number | null;
  requiredAuthority: string | null;
}) {
  if (!status) return <Badge tone="neutral">Margin —</Badge>;
  const pctLabel = marginPct === null ? "n/a" : `${marginPct.toFixed(2)}%`;
  if (status === "OK") {
    return <Badge tone="success">Margin OK · {pctLabel}</Badge>;
  }
  return (
    <Badge tone="warning">
      Margin BELOW_FLOOR · {pctLabel}
      {requiredAuthority ? ` · needs ${requiredAuthority}` : ""}
    </Badge>
  );
}
