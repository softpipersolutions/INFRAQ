"use client";

import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { Badge, Button, TextInput } from "@/components/ui";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import type { AppRouter } from "@/server/routers/_app";
import { trpc } from "@/trpc/react";

type SessionSummary = inferRouterOutputs<AppRouter>["chat"]["listSessions"][number];

type GroupLabel = "Today" | "Yesterday" | "Previous 7 days" | "Older";
const GROUP_ORDER: GroupLabel[] = ["Today", "Yesterday", "Previous 7 days", "Older"];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Calendar-day bucket (not a rolling 24h window) — matches chat-panel's day-divider logic. */
function groupLabelFor(iso: string): GroupLabel {
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  return "Older";
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3m ago" / "2h ago" / "5d ago"-style label, always relative to now. */
function relativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60_000);
  if (Math.abs(diffMin) < 60) return relativeTimeFormatter.format(diffMin, "minute");
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) return relativeTimeFormatter.format(diffHour, "hour");
  const diffDay = Math.round(diffHour / 24);
  if (Math.abs(diffDay) < 30) return relativeTimeFormatter.format(diffDay, "day");
  const diffMonth = Math.round(diffDay / 30);
  return relativeTimeFormatter.format(diffMonth, "month");
}

function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function matchesFilter(session: SessionSummary, query: string): boolean {
  if (!query) return true;
  const haystack = `${session.effectiveTitle} ${session.lastMessagePreview ?? ""}`.toLowerCase();
  return haystack.includes(query);
}

/**
 * Session sidebar (Phase C.5 chat overhaul WP3) — the conversation list
 * rendered by `ChatShell` both as the permanent md+ rail and inside the
 * mobile slide-over drawer. Pure client component: reads `trpc.chat.listSessions`
 * and drives rename/pin/archive/reset through the already-landed WP2 router.
 *
 * `onNavigate` is fired whenever a row (or "New chat") is activated — the
 * mobile drawer passes a callback that closes itself; the desktop rail
 * leaves it undefined.
 */
export function SessionSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const utils = trpc.useUtils();

  const [filterQuery, setFilterQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const list = trpc.chat.listSessions.useQuery({ includeArchived: showArchived });

  // The sidebar is mounted once per `/chat` layout and never remounts across
  // a session switch, so it has to explicitly refetch on route change (a new
  // session may have just been created/titled) rather than relying on
  // React Query's mount-time refetch.
  useEffect(() => {
    void utils.chat.listSessions.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on route change only
  }, [pathname]);

  // ⌘K / Ctrl+K → New chat, from anywhere while a `/chat` route is mounted.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onNavigate?.();
        router.push("/chat");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, onNavigate]);

  const activeSessionId = useMemo(() => pathname.match(/^\/chat\/([^/?#]+)/)?.[1] ?? null, [pathname]);

  const query = filterQuery.trim().toLowerCase();
  const all = list.data ?? [];
  const visible = all.filter((s) => matchesFilter(s, query));
  const activeVisible = visible.filter((s) => !s.archivedAt);
  const archivedVisible = visible.filter((s) => s.archivedAt);

  const pinned = activeVisible.filter((s) => s.pinnedAt);
  const unpinned = activeVisible.filter((s) => !s.pinnedAt);

  const groups = useMemo(() => {
    const map = new Map<GroupLabel, SessionSummary[]>();
    for (const s of unpinned) {
      const label = groupLabelFor(s.lastMessageAt ?? s.createdAt);
      const bucket = map.get(label);
      if (bucket) bucket.push(s);
      else map.set(label, [s]);
    }
    return map;
  }, [unpinned]);

  function newChat() {
    onNavigate?.();
    router.push("/chat");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-3">
        <Button
          type="button"
          variant="primary"
          className="w-full justify-center gap-1.5"
          onClick={newChat}
        >
          <Plus size={14} strokeWidth={2} aria-hidden />
          New chat
        </Button>
      </div>

      <div className="border-b border-border p-3">
        <div className="relative">
          <Search
            size={13}
            strokeWidth={2}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <TextInput
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search chats"
            className="pl-7 text-xs"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {list.isLoading ? (
          <div className="px-2 py-4 text-xs text-ink-muted">Loading…</div>
        ) : all.length === 0 ? (
          <div className="px-2 py-6 text-center">
            <p className="text-xs font-medium text-ink-secondary">No conversations yet</p>
            <p className="mt-1 text-xs text-ink-muted">Start a new chat to see it here.</p>
          </div>
        ) : visible.length === 0 && archivedVisible.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-ink-muted">No matches.</div>
        ) : (
          <>
            {pinned.length > 0 ? (
              <SessionGroup
                label="Pinned"
                sessions={pinned}
                activeSessionId={activeSessionId}
                onNavigate={onNavigate}
              />
            ) : null}
            {GROUP_ORDER.filter((label) => groups.has(label)).map((label) => (
              <SessionGroup
                key={label}
                label={label}
                sessions={groups.get(label) ?? []}
                activeSessionId={activeSessionId}
                onNavigate={onNavigate}
              />
            ))}
            {showArchived && archivedVisible.length > 0 ? (
              <SessionGroup
                label="Archived"
                sessions={archivedVisible}
                activeSessionId={activeSessionId}
                onNavigate={onNavigate}
              />
            ) : null}
          </>
        )}
      </div>

      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
        >
          <Archive size={13} strokeWidth={1.75} aria-hidden />
          {showArchived ? "Hide archived" : "Show archived"}
        </button>
      </div>
    </div>
  );
}

function SessionGroup({
  label,
  sessions,
  activeSessionId,
  onNavigate,
}: {
  label: string;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onNavigate?: () => void;
}) {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-1 px-2 py-1 text-xs uppercase tracking-wide text-ink-muted">
        {label === "Pinned" ? <Pin size={11} strokeWidth={2} aria-hidden /> : null}
        {label}
      </div>
      <div className="space-y-0.5">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            active={session.id === activeSessionId}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  active,
  onNavigate,
}: {
  session: SessionSummary;
  active: boolean;
  onNavigate?: () => void;
}) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.effectiveTitle);

  const invalidateList = () => void utils.chat.listSessions.invalidate();
  const rename = trpc.chat.rename.useMutation({ onSuccess: invalidateList });
  const pin = trpc.chat.pin.useMutation({ onSuccess: invalidateList });
  const archive = trpc.chat.archive.useMutation({ onSuccess: invalidateList });
  const reset = trpc.chat.reset.useMutation({
    onSuccess: () => void utils.chat.sessionState.invalidate({ sessionId: session.id }),
  });

  function startEditing() {
    setDraft(session.effectiveTitle);
    setEditing(true);
  }

  function commitEditing() {
    setEditing(false);
    const trimmed = draft.trim();
    if (!trimmed || trimmed === session.effectiveTitle) return;
    void rename.mutateAsync({ sessionId: session.id, title: trimmed });
  }

  const items: MenuItem[] = [
    { label: "Rename", icon: Pencil, onSelect: startEditing },
    {
      label: session.pinnedAt ? "Unpin" : "Pin",
      icon: Pin,
      onSelect: () => void pin.mutateAsync({ sessionId: session.id, pinned: !session.pinnedAt }),
    },
    {
      label: "Reset capture",
      icon: RotateCcw,
      onSelect: () => void reset.mutateAsync({ sessionId: session.id }),
    },
    {
      label: session.archivedAt ? "Unarchive" : "Archive",
      icon: session.archivedAt ? ArchiveRestore : Archive,
      onSelect: () => void archive.mutateAsync({ sessionId: session.id, archived: !session.archivedAt }),
    },
  ];

  return (
    <div
      className={`group relative flex items-center gap-1 rounded-md py-1.5 pl-2 pr-1 transition ${
        active ? "border-l-2 border-ink bg-surface-sunken pl-[7px]" : "border-l-2 border-transparent hover:bg-surface-sunken"
      }`}
    >
      {editing ? (
        <TextInput
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitEditing();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={commitEditing}
          className="h-7 flex-1 py-0.5 text-xs"
        />
      ) : (
        <Link href={`/chat/${session.id}`} onClick={onNavigate} className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {session.pinnedAt && !active ? (
              <Pin size={10} strokeWidth={2} className="shrink-0 text-ink-muted" aria-hidden />
            ) : null}
            <span className="truncate text-sm text-ink">{session.effectiveTitle}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <Tooltip label={absoluteTime(session.lastMessageAt ?? session.createdAt)}>
              <span className="text-[11px] text-ink-muted">
                {relativeTime(session.lastMessageAt ?? session.createdAt)}
              </span>
            </Tooltip>
            {session.enquiryId ? <Badge tone="info">{session.enquiryId}</Badge> : null}
          </div>
        </Link>
      )}

      {!editing ? (
        <Menu
          align="end"
          items={items}
          trigger={
            <button
              type="button"
              aria-label="Session options"
              className="shrink-0 rounded p-1 text-ink-muted opacity-0 transition hover:bg-surface hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
            >
              <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
            </button>
          }
        />
      ) : null}
    </div>
  );
}
