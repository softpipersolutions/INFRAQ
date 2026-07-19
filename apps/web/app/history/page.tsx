"use client";

import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, PageHeader, TextInput } from "@/components/ui";
import { trpc } from "@/trpc/react";

type RagHit = {
  id: string;
  sourceDocumentId: string;
  filename: string;
  chunkKind: string;
  content: string;
  metadata: Record<string, unknown> | null;
  score: number;
};

function chunkKindTone(kind: string): "blue" | "green" | "amber" | "neutral" {
  switch (kind) {
    case "boq_section":
      return "blue";
    case "doc_summary":
      return "green";
    case "terms":
      return "amber";
    default:
      return "neutral";
  }
}

/**
 * "What did we quote before?" — hybrid (keyword + vector) search over every
 * ingested historical proposal's RAG chunks. Any signed-in role can search;
 * results link out to the authenticated source-document viewer.
 */
export default function HistorySearchPage() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");

  const search = trpc.ingestion.search.useQuery(
    { query: submitted, k: 12 },
    { enabled: submitted.trim() !== "" },
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(query.trim());
  }

  return (
    <div>
      <PageHeader title="History" subtitle="Search the historical proposal corpus — “what did we quote before?”" />

      <Card className="mb-6 p-4">
        <form onSubmit={onSubmit} className="flex items-center gap-2">
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. smoke detector Agni Devices, hydrant pump 2024…"
            className="flex-1"
          />
          <Button type="submit" variant="primary" disabled={query.trim() === ""}>
            Search
          </Button>
        </form>
      </Card>

      {submitted === "" ? (
        <EmptyState>
          Search across every ingested proposal's BOQ sections, summaries and terms. The index
          grows as more of the historical corpus is extracted and staged — see{" "}
          <a href="/admin/ingestion" className="text-[var(--pebble-accent)] hover:underline">
            Ingestion
          </a>{" "}
          for corpus coverage.
        </EmptyState>
      ) : search.isLoading ? (
        <EmptyState>Searching…</EmptyState>
      ) : search.isError ? (
        <EmptyState>Search failed: {search.error.message}</EmptyState>
      ) : (search.data?.hits.length ?? 0) === 0 ? (
        <EmptyState>
          No matches for &ldquo;{submitted}&rdquo;. Try different terms — the index only covers
          documents that have already been ingested.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {search.data!.hits.map((hit) => (
            <HitCard key={hit.id} hit={hit} />
          ))}
        </div>
      )}
    </div>
  );
}

function HitCard({ hit }: { hit: RagHit }) {
  const metadata = hit.metadata ?? {};
  const systems = Array.isArray(metadata.systems)
    ? (metadata.systems as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const docDateISO = typeof metadata.docDateISO === "string" ? metadata.docDateISO : null;
  const section = typeof metadata.section === "string" ? metadata.section : null;
  const snippet = hit.content.length > 400 ? `${hit.content.slice(0, 400)}…` : hit.content;

  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone={chunkKindTone(hit.chunkKind)}>{hit.chunkKind}</Badge>
        <a
          href={`/api/source-documents/${hit.sourceDocumentId}`}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-[var(--pebble-accent)] hover:underline"
        >
          {hit.filename}
        </a>
        {systems.map((s) => (
          <Badge key={s} tone="blue">
            {s}
          </Badge>
        ))}
        {docDateISO ? <Badge tone="neutral">{docDateISO}</Badge> : null}
        {section ? <Badge tone="neutral">{section}</Badge> : null}
        <span className="ml-auto tabular text-xs text-[var(--pebble-muted)]">score {hit.score.toFixed(4)}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm text-[var(--pebble-ink)]">{snippet}</p>
    </Card>
  );
}
