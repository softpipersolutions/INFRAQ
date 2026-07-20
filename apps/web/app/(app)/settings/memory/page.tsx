"use client";

import { Brain } from "lucide-react";
import { useState } from "react";
import { Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { trpc } from "@/trpc/react";

/** Compact byte size, e.g. "480 B" / "1.4 KB". */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

/**
 * Memory inspection (Chat overhaul WP9). Lists the signed-in user's cross-session
 * memory files (what Pebble has chosen to remember), lets them read one's raw
 * content in a monospace panel, and delete one after a confirm. Everything is
 * owner-scoped by the memory router — a user only ever sees their OWN memory.
 */
export default function MemorySettingsPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const list = trpc.memory.list.useQuery();
  const file = trpc.memory.get.useQuery(
    { path: selected ?? "" },
    { enabled: selected !== null },
  );
  const del = trpc.memory.delete.useMutation({
    onSuccess: (_res, vars) => {
      if (selected === vars.path) setSelected(null);
      void utils.memory.list.invalidate();
    },
  });

  const files = list.data ?? [];

  function onDelete(path: string) {
    if (!window.confirm(`Delete ${path} from Pebble's memory? This cannot be undone.`)) return;
    del.mutate({ path });
  }

  return (
    <div>
      <PageHeader
        title="Memory"
        subtitle="What Pebble remembers about your clients and preferences across chats. Delete anything you'd rather it forget."
      />

      {list.isLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : files.length === 0 ? (
        <EmptyState>
          Pebble hasn&apos;t saved anything to memory yet. As you work, it will remember durable
          preferences and recurring specs here — never prices or figures.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_1fr]">
          <Card className="divide-y divide-border">
            {files.map((f) => {
              const active = f.path === selected;
              return (
                <div
                  key={f.path}
                  className={`flex items-center justify-between gap-2 px-3 py-2.5 ${
                    active ? "bg-surface-sunken" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelected(f.path)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <Brain size={14} strokeWidth={1.5} className="shrink-0 text-ink-muted" aria-hidden />
                      <span className="truncate text-sm font-medium text-ink">{f.path}</span>
                    </div>
                    <div className="mt-0.5 pl-6 text-xs text-ink-muted">
                      {formatBytes(f.sizeBytes)} · {formatDateTime(f.updatedAt.toISOString())}
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    onClick={() => onDelete(f.path)}
                    disabled={del.isPending}
                    aria-label={`Delete ${f.path}`}
                  >
                    Delete
                  </Button>
                </div>
              );
            })}
          </Card>

          <Card className="p-4">
            {selected === null ? (
              <p className="text-sm text-ink-muted">Select a file to view its contents.</p>
            ) : file.isLoading ? (
              <p className="text-sm text-ink-muted">Loading…</p>
            ) : file.data ? (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 className="truncate text-sm font-semibold text-ink">{file.data.path}</h2>
                  <span className="shrink-0 text-xs text-ink-muted">{formatBytes(file.data.sizeBytes)}</span>
                </div>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-sunken p-3 font-mono text-xs text-ink">
                  {file.data.content}
                </pre>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">That file could not be found.</p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
