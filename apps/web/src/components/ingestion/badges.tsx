import { Badge } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";

/** Tone for a staged_record.status / source_document.status value. */
function statusTone(status: string): BadgeTone {
  switch (status) {
    case "APPROVED":
    case "EDITED_APPROVED":
    case "DONE":
      return "success";
    case "REJECTED":
    case "FAILED":
      return "danger";
    case "MERGED":
    case "STAGED":
      return "info";
    case "PROPOSED":
    case "REGISTERED":
    case "META_DONE":
    case "LINES_DONE":
      return "warning";
    default:
      return "neutral";
  }
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status}</Badge>;
}

export function TargetMasterBadge({ targetMaster }: { targetMaster: string }) {
  return <Badge tone="info">{targetMaster}</Badge>;
}

/** Confidence badge, coloured by the ≥0.9 / ≥0.7 / else convention used across the queue. */
export function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence === null) return <Badge tone="neutral">confidence —</Badge>;
  const pct = `${Math.round(confidence * 100)}%`;
  if (confidence >= 0.9) return <Badge tone="success">confidence {pct}</Badge>;
  if (confidence >= 0.7) return <Badge tone="warning">confidence {pct}</Badge>;
  return <Badge tone="danger">confidence {pct}</Badge>;
}
