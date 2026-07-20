"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isTextUIPart, type UIMessage } from "ai";
import { ArrowDown, ArrowUp, Check, Copy, PanelLeft, RotateCw, Square } from "lucide-react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Badge, Button, Card, TextInput } from "@/components/ui";
import { Tooltip } from "@/components/ui/tooltip";
import { trpc } from "@/trpc/react";
import { useChatSidebarToggle } from "./chat-sidebar-context";
import { ConfirmationCard } from "./confirmation-card";
import { historyRowsToUIMessages } from "./history-to-ui-messages";
import { Markdown } from "./markdown";
import { SlotRail } from "./slot-rail";
import { isCreateEnquirySuccessPart, isToolPart, ReceiptCard, ToolActivityRow } from "./tool-activity";
import { useAutoscroll } from "./use-autoscroll";

/** Composer textarea grows from 1 to ~8 lines, then scrolls internally. */
const COMPOSER_MAX_HEIGHT_PX = 192;

/** Resets height to auto (so it can shrink) then grows to fit content, capped by the CSS max-height (overflow-y-auto takes over past that). */
function autoGrowTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
}

/** The three example prompts offered on the empty-state panel (spec §8). */
const EXAMPLE_PROMPTS = [
  "New enquiry: 4-floor commercial building, 450 sqm per floor, FAS + extinguishers, tier 2",
  "What did we quote for hydrant systems last year?",
  "Explain SITC pricing on my latest estimate",
];

function extractText(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts.filter(isTextUIPart).map((p) => p.text).join("");
}

/** Did this assistant message's turn include a successful `create_enquiry` (a receipt)? */
function messageHasSuccessfulCreateEnquiry(message: UIMessage | undefined): boolean {
  if (!message) return false;
  return message.parts.filter(isToolPart).some(isCreateEnquirySuccessPart);
}

/**
 * Pull a friendly notice out of a transport Error's message. /api/chat
 * returns JSON on 401 (signed out, `{ error }` only), 429 (daily budget,
 * `{ error, message }`) and 503 (model unconfigured, `{ error, message }`) —
 * `message` is the human-readable copy when present, `error` is a short
 * machine code (or, for 401, already a friendly sentence).
 */
function friendlyError(err: Error | undefined): string | null {
  if (!err) return null;
  try {
    const parsed = JSON.parse(err.message) as { error?: unknown; message?: unknown };
    if (typeof parsed?.message === "string" && parsed.message.length > 0) return parsed.message;
    if (typeof parsed?.error === "string" && parsed.error.length > 0) return parsed.error;
  } catch {
    // Not JSON — fall through to the raw message.
  }
  return err.message || "Something went wrong. Please try again.";
}

/** Per-message metadata sourced from the persisted `chat.history` transcript (createdAt/model), keyed by message id. Absent for messages still live-streaming in this tab (see chat-panel's local timestamp fallback). */
interface HistoryMeta {
  createdAt: string;
  model: string | null;
}

/** A stable per-local-timezone calendar-day key, for grouping/day-divider comparisons. */
function calendarDayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today" / "Yesterday" / a full local date, for the day-divider label. */
function calendarDayLabel(iso: string): string {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (calendarDayKey(iso) === calendarDayKey(now.toISOString())) return "Today";
  if (calendarDayKey(iso) === calendarDayKey(yesterday.toISOString())) return "Yesterday";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

export function ChatPanel({
  sessionId,
  onFirstMessageSent,
}: {
  /** Always present — the lobby mints one client-side, `[sessionId]` reads it from the route param. */
  sessionId: string;
  /**
   * Lobby-only: fired synchronously the moment the FIRST message of a
   * brand-new session is sent, so `chat/page.tsx` can promote the URL from
   * `/chat` to `/chat/{sessionId}` (via `window.history.replaceState`,
   * which — unlike `router.replace` — is guaranteed not to remount this
   * component, so the in-flight stream survives the swap). Omitted on the
   * `[sessionId]` route, where the URL is already correct.
   */
  onFirstMessageSent?: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();
  const toggleSidebar = useChatSidebarToggle();

  const [input, setInput] = useState("");
  const prefilledAsk = useRef(false);
  useEffect(() => {
    if (prefilledAsk.current) return;
    const ask = searchParams.get("ask");
    if (ask) {
      setInput(ask);
      prefilledAsk.current = true;
    }
  }, [searchParams]);

  // Auto-grow the composer to fit `input` (covers the prefill above and the
  // post-send reset below, not just direct typing).
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (textareaRef.current) autoGrowTextarea(textareaRef.current);
  }, [input]);

  // tRPC keys these queries by their input, so `sessionId` changing (a real
  // navigation to a different session) is enough to refetch both — no extra
  // effect/dep wiring needed beyond passing the prop through.
  const sessionState = trpc.chat.sessionState.useQuery({ sessionId });

  // Full transcript (parts + createdAt + model included) for hydrating a
  // reloaded session — a fresh session simply returns an empty list and the
  // empty-state panel stays put.
  const history = trpc.chat.history.useQuery({ sessionId });

  // The signed-in user's session list — used here only to resolve the
  // current session's title for the slim header below; the sidebar (a
  // sibling under the shared `/chat` layout) issues the identical query, so
  // React Query dedupes the two into a single request/cache entry.
  const sessions = trpc.chat.listSessions.useQuery();
  const activeSession = sessions.data?.find((s) => s.id === sessionId) ?? null;

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/chat",
        body: { sessionId },
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { ...body, message: extractText(messages[messages.length - 1]) },
        }),
      }),
    [sessionId],
  );

  const chat = useChat<UIMessage>({
    id: sessionId,
    messages: [],
    transport,
    // WP5 streaming feel: coalesce rapid text-delta re-renders into ~20fps
    // React updates instead of one render per SSE chunk — the model already
    // paces its own output via the server's smoothStream, this just keeps
    // the client from over-rendering on top of that.
    experimental_throttle: 50,
    onFinish: ({ message, isAbort, isError }) => {
      if (isAbort || isError) return;
      void sessionState.refetch();
      // The sidebar list orders by last-message activity and shows the title
      // the server may have just generated; the lobby's history.replaceState
      // URL promotion fires no router event, so this invalidation is the only
      // thing that makes a first exchange appear in the list.
      void utils.chat.listSessions.invalidate();
      // A receipt (successful create_enquiry) means the enquiry/estimate and
      // dashboard tiles just changed underneath this session.
      if (messageHasSuccessfulCreateEnquiry(message)) {
        void utils.dashboard.stats.invalidate();
      }
    },
  });

  // Hydrate once per session from the persisted transcript (parts included) so
  // a reload shows past tool activity + receipts, not just text. A brand-new
  // session has no rows yet, so the empty-state panel is left in place.
  // `useLayoutEffect` (not `useEffect`) so the swap from "no messages yet"
  // to the real transcript happens before paint — otherwise a returning
  // session can flash the empty state for one frame while history loads.
  const hydratedSessionIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!history.data) return;
    if (hydratedSessionIdRef.current === sessionId) return;
    hydratedSessionIdRef.current = sessionId;
    if (history.data.length > 0) {
      chat.setMessages(historyRowsToUIMessages(history.data));
    }
  }, [sessionId, history.data, chat]);

  const streaming = chat.status === "submitted" || chat.status === "streaming";

  // ─── Per-message timestamp / model metadata ────────────────────────────
  const historyMetaById = useMemo(() => {
    const map = new Map<string, HistoryMeta>();
    for (const row of history.data ?? []) {
      map.set(row.id, { createdAt: row.createdAt, model: row.model ?? null });
    }
    return map;
  }, [history.data]);

  // Messages not (yet) in the persisted history — freshly sent/streamed in
  // this tab — get a local, client-side timestamp instead, per spec §5.
  const localTimestampsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const m of chat.messages) {
      if (historyMetaById.has(m.id)) continue;
      if (!localTimestampsRef.current.has(m.id)) {
        localTimestampsRef.current.set(m.id, new Date().toISOString());
      }
    }
  }, [chat.messages, historyMetaById]);

  function timestampFor(id: string): string | null {
    return historyMetaById.get(id)?.createdAt ?? localTimestampsRef.current.get(id) ?? null;
  }
  /** Only persisted (reloaded) messages carry a model — a live stream doesn't expose it to the client. */
  function modelFor(id: string): string | null {
    return historyMetaById.get(id)?.model ?? null;
  }

  const autoscroll = useAutoscroll(`${chat.messages.length}:${chat.status}`);

  async function send(explicitText?: string) {
    const text = (explicitText ?? input).trim();
    if (!text || streaming) return;
    if (explicitText === undefined) setInput("");
    // Fire BEFORE awaiting the send — the lobby's URL swap (see chat/page.tsx)
    // must happen at send-time, not once the turn finishes streaming.
    if (chat.messages.length === 0) onFirstMessageSent?.();
    await chat.sendMessage({ text });
  }

  const confirmEnquiry = trpc.chat.confirmEnquiry.useMutation();
  const [confirmError, setConfirmError] = useState<string | null>(null);

  async function onConfirm() {
    setConfirmError(null);
    try {
      const result = await confirmEnquiry.mutateAsync({ sessionId });
      void utils.dashboard.stats.invalidate();
      router.push(`/estimates/${result.estimateId}`);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : "Failed to create the enquiry.");
    }
  }

  // "Start over" is now "New chat" (spec WP3 §4) — it navigates to the
  // lobby, which mints a brand-new session id, rather than resetting this
  // one in place. The old in-place reset survives as "Reset capture" in the
  // sidebar's per-session menu (see session-sidebar.tsx).
  function onNewChat() {
    router.push("/chat");
  }

  // ─── Slim conversation header: session title, rename-on-click ──────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const renameSession = trpc.chat.rename.useMutation({
    onSuccess: () => void utils.chat.listSessions.invalidate(),
  });

  function startEditingTitle() {
    if (!activeSession) return;
    setTitleDraft(activeSession.effectiveTitle);
    setEditingTitle(true);
  }

  function commitTitle() {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (!activeSession || !trimmed || trimmed === activeSession.effectiveTitle) return;
    void renameSession.mutateAsync({ sessionId, title: trimmed });
  }

  /**
   * Retry the last assistant response. `chat.regenerate()` (verified present
   * on the installed @ai-sdk/react's `UseChatHelpers`) trims local state back
   * to the preceding user message and resends it through the same transport
   * — exactly what a manual resend would do — so it's the primary path; a
   * manual `sendMessage` of the last user text is the documented fallback if
   * it ever throws (e.g. an unexpected local-state shape).
   */
  async function onRetryLast() {
    if (streaming) return;
    try {
      await chat.regenerate();
    } catch {
      const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
      const text = extractText(lastUser);
      if (text) await chat.sendMessage({ text });
    }
  }

  let lastAssistantIndex = -1;
  for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
    if (chat.messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  const lastMessage = chat.messages[chat.messages.length - 1];
  // The generic "Thinking…" row only covers the gap before the streaming
  // message has produced its first visible part — once text or a tool call
  // starts arriving, the real MessageBubble (with its own per-tool activity
  // rows) takes over.
  const showGenericThinking =
    streaming && (!lastMessage || lastMessage.role !== "assistant" || lastMessage.parts.length === 0);

  const showEmptyState = chat.messages.length === 0 && !streaming && !history.isLoading;

  const errorMessage = friendlyError(chat.error);

  let lastDayKey: string | null = null;

  return (
    <div className="flex flex-col gap-4">
      <SlotRail slotState={sessionState.data?.slotState} />

      <Card className="flex h-[60vh] min-h-[420px] flex-col overflow-hidden">
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
          <button
            type="button"
            aria-label="Toggle sessions"
            onClick={toggleSidebar}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted transition hover:bg-surface-sunken hover:text-ink md:hidden"
          >
            <PanelLeft size={15} strokeWidth={1.75} aria-hidden />
          </button>
          {editingTitle ? (
            <TextInput
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTitle();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingTitle(false);
                }
              }}
              onBlur={commitTitle}
              className="h-7 max-w-xs py-0.5 text-sm"
            />
          ) : (
            <button
              type="button"
              onClick={startEditingTitle}
              disabled={!activeSession}
              title={activeSession ? "Click to rename" : undefined}
              className="truncate rounded px-1.5 py-0.5 text-left text-sm font-medium text-ink transition hover:bg-surface-sunken disabled:cursor-default disabled:hover:bg-transparent"
            >
              {activeSession?.effectiveTitle ?? "New chat"}
            </button>
          )}
        </div>

        <div className="relative flex-1 overflow-hidden">
          <div ref={autoscroll.containerRef} className="h-full overflow-y-auto p-4">
            {showEmptyState ? (
              <EmptyState disabled={streaming} onPick={(text) => void send(text)} />
            ) : (
              <div className="space-y-3">
                {chat.messages.map((message, i) => {
                  const iso = timestampFor(message.id);
                  const dayKey = iso ? calendarDayKey(iso) : null;
                  const showDivider = dayKey !== null && lastDayKey !== null && dayKey !== lastDayKey;
                  if (dayKey !== null) lastDayKey = dayKey;
                  return (
                    <div key={message.id}>
                      {showDivider && iso ? <DayDivider iso={iso} /> : null}
                      <MessageBubble
                        message={message}
                        streaming={streaming && i === chat.messages.length - 1}
                        isLastAssistant={i === lastAssistantIndex}
                        timestampIso={iso}
                        model={modelFor(message.id)}
                        onRetry={() => void onRetryLast()}
                      />
                    </div>
                  );
                })}
                {showGenericThinking ? (
                  <div className="flex items-center gap-1 text-xs text-ink-muted" aria-live="polite">
                    <span>Thinking</span>
                    <span className="thinking-dot" aria-hidden>
                      .
                    </span>
                    <span className="thinking-dot" aria-hidden>
                      .
                    </span>
                    <span className="thinking-dot" aria-hidden>
                      .
                    </span>
                  </div>
                ) : null}
                <div ref={autoscroll.endRef} />
              </div>
            )}
          </div>

          {autoscroll.isDetached ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
              <button
                type="button"
                onClick={autoscroll.jumpToLatest}
                className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-inverse shadow-overlay transition hover:bg-grey-800"
              >
                <ArrowDown size={14} strokeWidth={2} aria-hidden />
                Jump to latest
              </button>
            </div>
          ) : null}
        </div>

        {errorMessage ? (
          <div className="flex items-center justify-between gap-3 border-t border-danger-border bg-danger-soft px-4 py-2 text-sm text-danger">
            <span>{errorMessage}</span>
            <button type="button" className="shrink-0 underline" onClick={() => chat.clearError()}>
              Dismiss
            </button>
          </div>
        ) : null}

        <form
          className="flex items-end gap-2 border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="chat-composer" className="sr-only">
            Message Pebble
          </label>
          <textarea
            id="chat-composer"
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrowTextarea(e.target);
            }}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={streaming}
            placeholder="Tell me about the enquiry, or ask a question…"
            enterKeyHint="send"
            className="max-h-48 flex-1 resize-none overflow-y-auto rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted outline-none focus:border-ink disabled:cursor-not-allowed disabled:opacity-50"
          />
          {streaming ? (
            <Tooltip label="Stop generating">
              <button
                type="button"
                aria-label="Stop generating"
                onClick={() => void chat.stop()}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-ink transition hover:bg-grey-100"
              >
                <Square size={15} strokeWidth={2} fill="currentColor" aria-hidden />
              </button>
            </Tooltip>
          ) : (
            <Tooltip label="Send message">
              <button
                type="submit"
                aria-label="Send message"
                disabled={streaming || input.trim() === ""}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-inverse transition hover:bg-grey-800 disabled:cursor-not-allowed disabled:bg-grey-200 disabled:text-ink-muted"
              >
                <ArrowUp size={18} strokeWidth={2} aria-hidden />
              </button>
            </Tooltip>
          )}
          <Button type="button" variant="ghost" onClick={onNewChat}>
            New chat
          </Button>
        </form>
      </Card>

      {sessionState.isError ? (
        <div className="rounded-md border border-danger-border bg-danger-soft px-4 py-3 text-sm text-danger">
          {sessionState.error.message}
        </div>
      ) : null}

      {sessionState.data?.readyToConfirm ? (
        <ConfirmationCard
          slotState={sessionState.data.slotState}
          onConfirm={onConfirm}
          pending={confirmEnquiry.isPending}
          error={confirmError}
        />
      ) : sessionState.data?.enquiryId ? (
        <div className="rounded-md border border-border-strong bg-surface px-4 py-3 text-sm text-ink">
          Enquiry <span className="font-semibold">{sessionState.data.enquiryId}</span> has been
          created from this conversation — find its estimate on the{" "}
          <a href="/dashboard" className="underline">
            dashboard
          </a>
          , or start a new chat for a new enquiry.
        </div>
      ) : null}
    </div>
  );
}

/**
 * Centered branded panel shown instead of the message list until the first
 * turn lands (spec §8) — monogram, heading, one-line subtitle, and three
 * example-prompt chips that send their text directly on click. The `?ask=`
 * prefill path is untouched by this: it only ever populates the composer
 * (see the effect in `ChatPanel`), which stays mounted below regardless of
 * which view (empty state vs. transcript) is showing here.
 */
function EmptyState({ disabled, onPick }: { disabled: boolean; onPick: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 py-8 text-center">
      <Image src="/brand/monogram.png" alt="" width={40} height={40} className="opacity-90" />
      <div>
        <h2 className="text-base font-semibold text-ink">Pebble</h2>
        <p className="mt-1 max-w-sm text-sm text-ink-muted">
          Greenberg&apos;s estimating assistant — describe the enquiry and I&apos;ll capture the details,
          pull past quotes, and draft the estimate.
        </p>
      </div>
      <div className="flex w-full max-w-md flex-col gap-2">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={disabled}
            onClick={() => onPick(prompt)}
            className="rounded-full border border-border px-3 py-1.5 text-left text-sm text-ink-secondary transition hover:bg-ink hover:text-inverse disabled:cursor-not-allowed disabled:opacity-50"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A labelled horizontal rule between messages from different calendar days (spec §6). */
function DayDivider({ iso }: { iso: string }) {
  return (
    <div
      role="separator"
      className="my-3 flex items-center gap-3 text-[11px] font-medium uppercase tracking-wide text-ink-muted"
    >
      <span className="h-px flex-1 bg-border" aria-hidden />
      {calendarDayLabel(iso)}
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

/**
 * Renders `message.parts` IN ORDER: text parts as prose bubbles (user stays
 * plain `whitespace-pre-wrap` text; assistant renders through `<Markdown/>`),
 * tool parts as a compact `ToolActivityRow`, and a successful
 * `tool-create_enquiry` part as a `ReceiptCard` instead of its row (the
 * receipt replaces the row, it isn't shown alongside it). `streaming` is true
 * only for the single in-flight assistant message, so the incomplete-markdown
 * guard (and the trailing caret) only ever touch text that's still actively
 * arriving.
 *
 * Assistant messages carry a hover/focus-within action row (spec §5/§7):
 * an "Opus" chip when this turn used the Opus model, Copy, Retry (last
 * assistant message only), and a timestamp with a full-datetime tooltip.
 */
function MessageBubble({
  message,
  streaming,
  isLastAssistant,
  timestampIso,
  model,
  onRetry,
}: {
  message: UIMessage;
  streaming: boolean;
  isLastAssistant: boolean;
  timestampIso: string | null;
  model: string | null;
  onRetry: () => void;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    },
    [],
  );

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(extractText(message));
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions / insecure context) — no-op.
    }
  }

  const showOpusBadge = !isUser && !!model && model.startsWith("claude-opus");

  return (
    <div className={`message-enter group flex flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}>
      {message.parts.map((part, i) => {
        const isLastPart = i === message.parts.length - 1;
        if (part.type === "text") {
          if (!part.text) return null;
          if (isUser) {
            return (
              <div
                key={i}
                className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-ink px-3 py-2 text-sm text-inverse"
              >
                {part.text}
              </div>
            );
          }
          return (
            <div
              key={i}
              className="max-w-[80%] rounded-lg border border-border bg-surface-sunken px-3 py-2 text-ink"
            >
              <Markdown text={part.text} streaming={streaming} />
              {streaming && isLastPart ? <span className="streaming-caret" aria-hidden /> : null}
            </div>
          );
        }
        if (isToolPart(part)) {
          return (
            <div key={i} className="max-w-[80%]">
              {isCreateEnquirySuccessPart(part) ? (
                <ReceiptCard output={part.output} />
              ) : (
                <ToolActivityRow part={part} />
              )}
            </div>
          );
        }
        return null;
      })}

      {!isUser && message.parts.length > 0 ? (
        <div
          className={`flex items-center gap-1 transition-opacity ${
            copied ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          }`}
        >
          {showOpusBadge ? <Badge tone="info">Opus</Badge> : null}
          <Tooltip label={copied ? "Copied" : "Copy"}>
            <button
              type="button"
              aria-label="Copy message"
              onClick={() => void onCopy()}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
            >
              {copied ? (
                <Check size={13} strokeWidth={1.75} aria-hidden />
              ) : (
                <Copy size={13} strokeWidth={1.75} aria-hidden />
              )}
            </button>
          </Tooltip>
          {isLastAssistant ? (
            <Tooltip label="Retry">
              <button
                type="button"
                aria-label="Retry this response"
                disabled={streaming}
                onClick={onRetry}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-muted transition hover:bg-surface-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCw size={13} strokeWidth={1.75} aria-hidden />
              </button>
            </Tooltip>
          ) : null}
          {timestampIso ? (
            <Tooltip
              label={new Date(timestampIso).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            >
              <span className="tabular px-1 text-[11px] text-ink-muted">
                {new Date(timestampIso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </span>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
