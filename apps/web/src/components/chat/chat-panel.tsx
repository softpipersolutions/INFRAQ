"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isTextUIPart, type UIMessage } from "ai";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, TextInput } from "@/components/ui";
import { trpc } from "@/trpc/react";
import { ConfirmationCard } from "./confirmation-card";
import { getOrCreateSessionId, resetSessionId } from "./session-id";
import { SlotRail } from "./slot-rail";

/** Client-side static intro — never a model call. */
const INTRO_MESSAGE: UIMessage = {
  id: "intro",
  role: "assistant",
  parts: [
    {
      type: "text",
      text:
        "Hi! Tell me about a fire-safety enquiry — client, project, building type, systems required — " +
        "and I'll capture it and hand off to the same estimator that powers the form. You can also ask me " +
        "to explain a line on an existing estimate.",
    },
  ],
};

function extractText(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts.filter(isTextUIPart).map((p) => p.text).join("");
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

function toolChipLabel(part: UIMessage["parts"][number]): string | null {
  if (part.type === "dynamic-tool") {
    return part.toolName.replace(/_/g, " ");
  }
  if (part.type.startsWith("tool-")) {
    return part.type.slice("tool-".length).replace(/_/g, " ");
  }
  return null;
}

export function ChatPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();

  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    setSessionId(getOrCreateSessionId());
  }, []);

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

  const sessionState = trpc.chat.sessionState.useQuery(
    { sessionId: sessionId ?? "" },
    { enabled: !!sessionId },
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/chat",
        body: { sessionId: sessionId ?? "" },
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { ...body, message: extractText(messages[messages.length - 1]) },
        }),
      }),
    [sessionId],
  );

  const chat = useChat<UIMessage>({
    id: sessionId ?? undefined,
    messages: [INTRO_MESSAGE],
    transport,
    onFinish: ({ isAbort, isError }) => {
      if (!isAbort && !isError) void sessionState.refetch();
    },
  });

  const streaming = chat.status === "submitted" || chat.status === "streaming";

  async function send() {
    const text = input.trim();
    if (!text || !sessionId || streaming) return;
    setInput("");
    await chat.sendMessage({ text });
  }

  const confirmEnquiry = trpc.chat.confirmEnquiry.useMutation();
  const [confirmError, setConfirmError] = useState<string | null>(null);

  async function onConfirm() {
    if (!sessionId) return;
    setConfirmError(null);
    try {
      const result = await confirmEnquiry.mutateAsync({ sessionId });
      void utils.dashboard.stats.invalidate();
      router.push(`/estimates/${result.estimateId}`);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : "Failed to create the enquiry.");
    }
  }

  const resetSession = trpc.chat.reset.useMutation();
  async function onStartOver() {
    if (sessionId) {
      try {
        await resetSession.mutateAsync({ sessionId });
      } catch {
        // Best-effort — a fresh session id below makes this moot either way.
      }
    }
    setConfirmError(null);
    setInput("");
    setSessionId(resetSessionId());
  }

  const errorMessage = friendlyError(chat.error);

  return (
    <div className="flex flex-col gap-4">
      <SlotRail slotState={sessionState.data?.slotState} />

      <Card className="flex h-[60vh] min-h-[420px] flex-col overflow-hidden">
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {chat.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {streaming ? (
            <div className="flex items-center gap-2 text-xs text-[var(--pebble-muted)]">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--pebble-accent)]" />
              Thinking…
            </div>
          ) : null}
        </div>

        {errorMessage ? (
          <div className="flex items-center justify-between gap-3 border-t border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            <span>{errorMessage}</span>
            <button type="button" className="shrink-0 underline" onClick={() => chat.clearError()}>
              Dismiss
            </button>
          </div>
        ) : null}

        <form
          className="flex items-center gap-2 border-t border-[var(--pebble-border)] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <TextInput
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={!sessionId || streaming}
            placeholder={sessionId ? "Tell me about the enquiry, or ask a question…" : "Starting chat…"}
            className="flex-1"
          />
          <Button type="submit" variant="primary" disabled={!sessionId || streaming || input.trim() === ""}>
            Send
          </Button>
          <Button type="button" variant="ghost" onClick={() => void onStartOver()}>
            Start over
          </Button>
        </form>
      </Card>

      {sessionState.isError ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
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
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Enquiry <span className="font-semibold">{sessionState.data.enquiryId}</span> has been
          created from this conversation — find its estimate on the{" "}
          <a href="/" className="underline">
            dashboard
          </a>
          , or start over for a new enquiry.
        </div>
      ) : null}
    </div>
  );
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? "bg-[var(--pebble-accent)] text-white"
            : "border border-[var(--pebble-border)] bg-slate-50 text-[var(--pebble-ink)]"
        }`}
      >
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return (
              <p key={i} className="whitespace-pre-wrap">
                {part.text}
              </p>
            );
          }
          const chip = toolChipLabel(part);
          if (chip) {
            return (
              <div key={i} className="mt-1 first:mt-0">
                <Badge tone={isUser ? "neutral" : "blue"}>looked up: {chip}</Badge>
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
