"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { ConfidenceBadge, TargetMasterBadge } from "@/components/ingestion/badges";
import { DEDUP_SIMILARITY_THRESHOLD, DedupCard } from "@/components/ingestion/dedup-card";
import { FIRST_FIELD_ID, StagedPayloadForm } from "@/components/ingestion/staged-payload-form";
import { trpc } from "@/trpc/react";

type Json = Record<string, unknown>;

/**
 * The keyboard-driven, two-pane verification queue for Phase B ingestion.
 * Left pane streams the source document (PDF/Excel) via the authenticated
 * /api/source-documents/[id] route inside an <iframe>; right pane is the
 * staged proposal — an editable form, the raw source text it was extracted
 * from, and a trigram dedup card. Every review action (approve/edit-approve/
 * reject/merge) invalidates the queue query, which naturally advances the
 * numeric cursor onto the next item (the just-reviewed row drops out of the
 * PROPOSED-filtered list, shifting the next row into the same index).
 *
 * Wrapped in Suspense because this route has no dynamic segment, so Next
 * attempts to statically prerender it — useSearchParams() requires a
 * Suspense boundary in that case.
 */
export default function IngestionQueuePage() {
  return (
    <Suspense fallback={<EmptyState>Loading…</EmptyState>}>
      <IngestionQueueContent />
    </Suspense>
  );
}

function IngestionQueueContent() {
  const searchParams = useSearchParams();
  const docId = searchParams.get("doc");

  const utils = trpc.useUtils();
  const queueQuery = trpc.ingestion.queue.list.useQuery({
    status: ["PROPOSED"],
    sourceDocumentId: docId ?? undefined,
    limit: 100,
  });
  const statsQuery = trpc.ingestion.stats.useQuery();

  const items = queueQuery.data ?? [];
  const [index, setIndex] = useState(0);
  const safeIndex = items.length === 0 ? 0 : Math.min(index, items.length - 1);
  const current = items[safeIndex];

  const [notice, setNotice] = useState<string | null>(null);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<Json | null>(null);

  // Fresh edit buffer whenever the current staged record changes.
  useEffect(() => {
    setEditValue(null);
    setNotice(null);
  }, [current?.id]);

  const currentMaterialName = current ? materialNameOf(current.targetMaster, current.proposed) : null;
  const dedupQuery = trpc.ingestion.dedupSuggestions.useQuery(
    { name: currentMaterialName ?? "" },
    { enabled: !!currentMaterialName },
  );

  function invalidateAll() {
    void utils.ingestion.queue.list.invalidate();
    void utils.ingestion.stats.invalidate();
    void utils.ingestion.documents.list.invalidate();
  }

  const approve = trpc.ingestion.approve.useMutation({
    onSuccess: (result) => setNotice(outcomeMessage(result.decision, result.outcome)),
    onError: (err) => setNotice(`Approve failed: ${err.message}`),
    onSettled: invalidateAll,
  });
  const editApprove = trpc.ingestion.editApprove.useMutation({
    onSuccess: (result) => setNotice(outcomeMessage(result.decision, result.outcome)),
    onError: (err) => setNotice(`Save failed: ${err.message}`),
    onSettled: invalidateAll,
  });
  const reject = trpc.ingestion.reject.useMutation({
    onSuccess: () => setNotice("Rejected."),
    onError: (err) => setNotice(`Reject failed: ${err.message}`),
    onSettled: invalidateAll,
  });
  const merge = trpc.ingestion.merge.useMutation({
    onSuccess: (result) => setNotice(outcomeMessage(result.decision, result.outcome)),
    onError: (err) => setNotice(`Merge failed: ${err.message}`),
    onSettled: invalidateAll,
  });
  const bulkApprove = trpc.ingestion.bulkApprove.useMutation({
    onSuccess: (results) => {
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      setBulkMsg(`Bulk approve: ${ok} committed${failed > 0 ? `, ${failed} failed` : ""}.`);
    },
    onError: (err) => setBulkMsg(`Bulk approve failed: ${err.message}`),
    onSettled: invalidateAll,
  });

  const busy = approve.isPending || editApprove.isPending || reject.isPending || merge.isPending;

  function goNext() {
    setIndex((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
  }
  function goPrev() {
    setIndex((i) => Math.max(i - 1, 0));
  }
  function onApprove() {
    if (!current || busy) return;
    approve.mutate({ stagedRecordId: current.id });
  }
  function onReject() {
    if (!current || busy) return;
    reject.mutate({ stagedRecordId: current.id });
  }
  function onMergeInto(materialCode: string) {
    if (!current || busy) return;
    merge.mutate({ stagedRecordId: current.id, mergeIntoCode: materialCode });
  }
  function onMergeTop() {
    const top = dedupQuery.data?.[0];
    if (!top) {
      setNotice("No dedup suggestion loaded to merge into — open the dedup card first.");
      return;
    }
    onMergeInto(top.materialCode);
  }
  function onSaveEdits() {
    if (!current || !editValue || busy) return;
    editApprove.mutate({ stagedRecordId: current.id, edits: editValue });
  }

  async function onBulkApprove() {
    const byConfidence = items.filter(
      (it) => (it.confidence ?? 0) >= 0.9 && unitNormalizedOk(it.targetMaster, it.proposed),
    );
    const eligible: string[] = [];
    for (const it of byConfidence) {
      const name = materialNameOf(it.targetMaster, it.proposed);
      if (!name) {
        eligible.push(it.id);
        continue;
      }
      try {
        const suggestions = await utils.ingestion.dedupSuggestions.fetch({ name });
        const top = suggestions[0]?.similarity ?? 0;
        if (top < DEDUP_SIMILARITY_THRESHOLD) eligible.push(it.id);
      } catch {
        // Fetch failure — conservatively exclude from the batch.
      }
    }
    if (eligible.length === 0) {
      setBulkMsg("No loaded items meet the ≥90% confidence / no-dedup-match bar.");
      return;
    }
    const ok = window.confirm(
      `Bulk-approve ${eligible.length} of ${items.length} loaded staged record(s)?\n` +
        `(confidence ≥ 90%, unit normalized, no dedup match ≥ ${Math.round(DEDUP_SIMILARITY_THRESHOLD * 100)}%)`,
    );
    if (!ok) return;
    setBulkMsg(null);
    bulkApprove.mutate({ stagedRecordIds: eligible });
  }

  // Keyboard shortcuts, disabled while a form field has focus.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isInputFocused() || e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "a":
          e.preventDefault();
          onApprove();
          break;
        case "e":
          e.preventDefault();
          document.getElementById(FIRST_FIELD_ID)?.focus();
          break;
        case "r":
          e.preventDefault();
          onReject();
          break;
        case "m":
          e.preventDefault();
          onMergeTop();
          break;
        case "j":
          e.preventDefault();
          goNext();
          break;
        case "k":
          e.preventDefault();
          goPrev();
          break;
        case "A":
          if (e.shiftKey) {
            e.preventDefault();
            void onBulkApprove();
          }
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // Re-subscribed whenever the acting item / dedup data changes so the
    // closures above always see fresh state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, items, dedupQuery.data, busy]);

  const sourceLocator = current?.sourceLocator as { page?: number } | null | undefined;
  const page = sourceLocator?.page ?? 1;
  const sourceText = current && typeof current.proposed.sourceText === "string" ? current.proposed.sourceText : null;

  return (
    <div>
      <PageHeader
        title="Verification queue"
        subtitle="Keyboard-driven review: a approve · e edit · r reject · m merge · j/k next/prev · Shift+A bulk approve"
        actions={
          <div className="flex items-center gap-2">
            {docId ? (
              <Link href="/admin/ingestion/queue">
                <Button variant="ghost">Clear document filter</Button>
              </Link>
            ) : null}
            <Button variant="secondary" onClick={() => void onBulkApprove()} disabled={bulkApprove.isPending}>
              {bulkApprove.isPending ? "Bulk approving…" : "Bulk approve confident (Shift+A)"}
            </Button>
          </div>
        }
      />

      {bulkMsg ? (
        <div className="mb-3 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm">
          {bulkMsg}
        </div>
      ) : null}

      {queueQuery.isLoading ? (
        <EmptyState>Loading queue…</EmptyState>
      ) : items.length === 0 ? (
        <EmptyState>
          Nothing to review{docId ? " for this document" : ""}. The queue fills as the worker's extraction
          pipeline stages proposals from the historical corpus.
          {docId ? (
            <div className="mt-2">
              <Link href="/admin/ingestion/queue" className="text-ink hover:underline">
                View the full queue
              </Link>
            </div>
          ) : null}
        </EmptyState>
      ) : !current ? (
        <EmptyState>Loading…</EmptyState>
      ) : (
        <>
          <div className="mb-3 text-sm text-ink-muted">
            {safeIndex + 1} of {items.length} · {docId ? "this document" : "all documents"}
            {docId ? ` (${statsQuery.data?.byStatus.PROPOSED ?? "…"} PROPOSED across all documents)` : ""}
          </div>

          {notice ? (
            <div className="mb-3 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm">
              {notice}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-border px-4 py-2 text-sm font-semibold">
                <span className="truncate">{current.filename}</span>
                {current.fileRef ? <span className="font-mono text-xs text-ink-muted">{current.fileRef}</span> : null}
              </div>
              <iframe
                key={current.id}
                src={`/api/source-documents/${current.sourceDocumentId}#page=${page}`}
                className="w-full"
                style={{ minHeight: "70vh", border: "none" }}
                title={`Source document — ${current.filename}`}
              />
            </Card>

            <div className="space-y-4">
              <Card className="p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <TargetMasterBadge targetMaster={current.targetMaster} />
                  <ConfidenceBadge confidence={current.confidence} />
                  {current.dedupCandidateCode ? (
                    <Badge tone="warning">flagged dup: {current.dedupCandidateCode}</Badge>
                  ) : null}
                </div>

                <StagedPayloadForm
                  key={current.id}
                  targetMaster={current.targetMaster}
                  proposed={current.proposed}
                  onChange={setEditValue}
                />

                {sourceText ? (
                  <blockquote className="mt-4 border-l-2 border-border pl-3 text-sm italic text-ink-muted">
                    {sourceText}
                  </blockquote>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabled={busy} onClick={onApprove}>
                    {approve.isPending ? "Approving…" : "Approve (a)"}
                  </Button>
                  <Button variant="secondary" disabled={busy || !editValue} onClick={onSaveEdits}>
                    {editApprove.isPending ? "Saving…" : "Save edits & approve"}
                  </Button>
                  <Button variant="danger" disabled={busy} onClick={onReject}>
                    {reject.isPending ? "Rejecting…" : "Reject (r)"}
                  </Button>
                  <div className="ml-auto flex items-center gap-1">
                    <Button variant="ghost" disabled={safeIndex === 0} onClick={goPrev}>
                      ← prev (k)
                    </Button>
                    <Button variant="ghost" disabled={safeIndex >= items.length - 1} onClick={goNext}>
                      next (j) →
                    </Button>
                  </div>
                </div>
              </Card>

              <DedupCard
                materialName={currentMaterialName}
                suggestions={dedupQuery.data}
                isLoading={dedupQuery.isLoading}
                onMergeInto={onMergeInto}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

function materialNameOf(targetMaster: string, proposed: Json): string | null {
  if (targetMaster !== "materials") return null;
  const material = proposed.material;
  if (!material || typeof material !== "object") return null;
  const name = (material as Json).materialName;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}

function unitNormalizedOk(targetMaster: string, proposed: Json): boolean {
  if (targetMaster !== "materials") return true;
  const material = proposed.material;
  if (!material || typeof material !== "object") return false;
  const unit = (material as Json).unitOfMeasure;
  if (!unit || typeof unit !== "object") return false;
  return typeof (unit as Json).normalized === "string";
}

interface CommitOutcomeLike {
  kind: string;
  materialCode?: string;
  makeCode?: string;
  priceId?: string;
  installRateId?: string;
  degraded: boolean;
}

/** Human summary of a CommitResult for the inline notice — "created X" / "degraded to price on Y". */
function outcomeMessage(decision: string, outcome: CommitOutcomeLike): string {
  if (outcome.degraded) {
    return `${decision}: degraded to a price point on ${outcome.materialCode ?? "existing material"} (dedup match).`;
  }
  if (outcome.kind === "materials") {
    return `${decision}: created material ${outcome.materialCode ?? ""}.`.trim();
  }
  if (outcome.kind === "prices") {
    return `${decision}: recorded price on ${outcome.materialCode ?? ""}.`.trim();
  }
  if (outcome.kind === "makes") {
    return `${decision}: linked make ${outcome.makeCode ?? ""} to ${outcome.materialCode ?? ""}.`.trim();
  }
  return `${decision}: recorded install rate${outcome.materialCode ? ` for ${outcome.materialCode}` : ""}.`;
}
