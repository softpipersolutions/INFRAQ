/**
 * Phase C.5 WP5 — live conversation eval harness plumbing.
 *
 * Shared by every scenario under `eval/conversations/*.ts` and the runner at
 * `scripts/chat-agent-eval.ts`. NEVER imported by production code (`src/**`,
 * `app/**`) and NEVER run in CI — this harness calls the REAL Anthropic +
 * Gemini APIs.
 *
 * Responsibilities:
 *  - `requireChatModelsOrExit` — the hard env guard (exit 2 with instructions
 *    when the keys needed for a live run are missing).
 *  - `createHarnessCtx` — a fresh PGlite database (migrated + seeded, with the
 *    dev user row) plus `ChatModels` wired into an `EvalCtx` scenarios drive.
 *  - `consumeUiMessageStream` — the ONE robust SSE consumer for
 *    `runAgentTurn`'s `toUIMessageStreamResponse()` output: parses the
 *    `data: {...}\n\n` frames, joins text deltas in arrival order, and
 *    reconstructs one part per tool call (mirrors
 *    `src/server/chat-agent.ts#reconstructUiParts` closely enough for
 *    assertions, without depending on it).
 *  - cost/wall measurement helpers and the tolerant "no invented numbers"
 *    matcher used by the happy-path and explain-walkthrough cases.
 *
 * We import `src/server/*` modules read-only (never modify them — WP5 owns
 * only `scripts/**`, `eval/**`, the one `package.json` script line, and
 * PROGRESS.md). Those modules start with `import "server-only"`, which is a
 * no-op under plain Node/tsx execution (only bundlers honor the package's
 * "browser" condition) — `apps/web/test/chat-agent.test.ts` already relies on
 * exactly this under vitest.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createChatModelsFromEnv,
  MODULE02_FRAGMENT,
  PEBBLE_PERSONA,
  type ChatModels,
  type SlotField,
  type SlotState,
} from "@pebble/ai";
import {
  createDb,
  ensureDevUser,
  getLatestLlmCallForSession,
  insertLlmCall,
  migrateDb,
  registerSourceDocument,
  replaceDocChunks,
  schema,
  seedDatabase,
  sumLlmCostSince,
  type AppUser,
  type Db,
  type DbHandle,
} from "@pebble/db";
import { resetDigestCache, getCachedDigest } from "../src/server/digest-cache";
import { runAgentTurn } from "../src/server/chat-agent";

// ─── Model guard ──────────────────────────────────────────────────────────

/**
 * Resolve the chat models from env, exiting 2 (setup problem, never confused
 * with an assertion failure) with clear instructions when either lane is
 * unusable: Anthropic (Sonnet 5 + Opus 4.8, `ANTHROPIC_API_KEY`) or a Gemini
 * lane (Developer API key, or Vertex via `PEBBLE_AI_PROVIDER=vertex` +
 * `GOOGLE_VERTEX_PROJECT` + a short-lived `GOOGLE_VERTEX_ACCESS_TOKEN`).
 * Mirrors `packages/ai/eval/run-extraction-eval.ts`'s guard style.
 */
export function requireChatModelsOrExit(
  env: Record<string, string | undefined> = process.env,
): ChatModels {
  const models = createChatModelsFromEnv(env);
  const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);
  const hasGemini = models.classifier !== null;

  if (!hasAnthropic || !hasGemini) {
    const missing: string[] = [];
    if (!hasAnthropic) missing.push("ANTHROPIC_API_KEY (Claude Sonnet 5 + Opus 4.8)");
    if (!hasGemini) missing.push("a Gemini lane (extraction + summary compaction)");
    console.error(
      "\nchat-agent-eval needs REAL model access — it calls the live Anthropic and Gemini " +
        "APIs and is NEVER run in CI.\n" +
        `Missing: ${missing.join(", ")}.\n\n` +
        "Set BOTH of:\n" +
        "  1) ANTHROPIC_API_KEY=sk-ant-...\n" +
        "  2) a Gemini lane — either:\n" +
        "       GOOGLE_GENERATIVE_AI_API_KEY=...\n" +
        "     or (Vertex, postpaid via IAM):\n" +
        "       PEBBLE_AI_PROVIDER=vertex GOOGLE_VERTEX_PROJECT=<project> GOOGLE_VERTEX_LOCATION=global \\\n" +
        "       GOOGLE_VERTEX_ACCESS_TOKEN=$(gcloud auth print-access-token)\n\n" +
        "Then run, e.g.:\n" +
        "  ANTHROPIC_API_KEY=... GOOGLE_GENERATIVE_AI_API_KEY=... pnpm --filter @pebble/web eval:chat\n" +
        "or:\n" +
        "  ANTHROPIC_API_KEY=... PEBBLE_AI_PROVIDER=vertex GOOGLE_VERTEX_PROJECT=infraq-greenberg \\\n" +
        "  GOOGLE_VERTEX_LOCATION=global GOOGLE_VERTEX_ACCESS_TOKEN=$(gcloud auth print-access-token) \\\n" +
        "  pnpm --filter @pebble/web eval:chat -- --only happy-path\n",
    );
    process.exit(2);
  }
  return models;
}

// ─── SSE consumer (the UI-message stream) ────────────────────────────────

export interface ConsumedStream {
  text: string;
  parts: Array<Record<string, unknown>>;
}

/**
 * The ONE robust consumer for `runAgentTurn`'s `toUIMessageStreamResponse()`
 * body: reads the byte stream, splits on the SSE frame boundary (`\n\n`),
 * parses each `data: {...}` line's JSON, joins `text-delta` chunks per text
 * id in arrival order (segments separated by a blank line — matching
 * `chat-agent.ts#fullAssistantText`'s multi-step join), and reconstructs one
 * part per tool call (`tool-<name>`, progressing `input-available` →
 * `output-available` / `output-error`), matching the AI SDK's UI-message part
 * shape closely enough for eval assertions.
 */
export async function consumeUiMessageStream(response: Response): Promise<ConsumedStream> {
  const body = response.body;
  if (!body) return { text: await response.text(), parts: [] };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const textById = new Map<string, string>();
  const textOrder: string[] = [];
  const toolById = new Map<string, Record<string, unknown>>();
  const parts: Array<Record<string, unknown>> = [];

  const handleFrame = (frame: string) => {
    const line = frame.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = evt.type as string | undefined;
    switch (type) {
      case "text-start": {
        const id = evt.id as string;
        if (!textById.has(id)) {
          textById.set(id, "");
          textOrder.push(id);
        }
        break;
      }
      case "text-delta": {
        const id = evt.id as string;
        textById.set(id, (textById.get(id) ?? "") + ((evt.delta as string) ?? ""));
        break;
      }
      case "tool-input-available": {
        const toolCallId = evt.toolCallId as string;
        const part: Record<string, unknown> = {
          type: `tool-${evt.toolName as string}`,
          toolCallId,
          state: "input-available",
          input: evt.input,
        };
        toolById.set(toolCallId, part);
        parts.push(part);
        break;
      }
      case "tool-input-error": {
        const toolCallId = evt.toolCallId as string;
        const part: Record<string, unknown> = {
          type: `tool-${evt.toolName as string}`,
          toolCallId,
          state: "input-error",
          input: evt.input,
          errorText: evt.errorText,
        };
        toolById.set(toolCallId, part);
        parts.push(part);
        break;
      }
      case "tool-output-available": {
        const toolCallId = evt.toolCallId as string;
        const existing = toolById.get(toolCallId);
        if (existing) {
          existing.state = "output-available";
          existing.output = evt.output;
        } else {
          const part: Record<string, unknown> = {
            type: "tool-unknown",
            toolCallId,
            state: "output-available",
            output: evt.output,
          };
          toolById.set(toolCallId, part);
          parts.push(part);
        }
        break;
      }
      case "tool-output-error": {
        const toolCallId = evt.toolCallId as string;
        const existing = toolById.get(toolCallId);
        if (existing) {
          existing.state = "output-error";
          existing.errorText = evt.errorText;
        } else {
          parts.push({
            type: "tool-unknown",
            toolCallId,
            state: "output-error",
            errorText: evt.errorText,
          });
        }
        break;
      }
      case "error": {
        parts.push({ type: "error", errorText: evt.errorText });
        break;
      }
      default:
        break;
    }
  };

  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      handleFrame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim().length > 0) handleFrame(buf);

  const text = textOrder
    .map((id) => textById.get(id) ?? "")
    .filter((t) => t.length > 0)
    .join("\n\n");
  return { text, parts };
}

/** Non-200 responses (429 budget guard, 503 unconfigured) are plain JSON. */
async function consumeJsonResponse(response: Response): Promise<ConsumedStream> {
  const raw = await response.text();
  try {
    const obj = JSON.parse(raw) as { message?: string };
    return { text: typeof obj.message === "string" ? obj.message : raw, parts: [] };
  } catch {
    return { text: raw, parts: [] };
  }
}

// ─── Eval context ─────────────────────────────────────────────────────────

export interface TurnResult {
  text: string;
  parts: Array<Record<string, unknown>>;
  response: Response;
}

export interface EvalCtx {
  db: Db;
  models: ChatModels;
  user: AppUser;
  /** A fresh, unique chat_sessions id. */
  makeSession(): string;
  /** One agent turn: runs `runAgentTurn` directly (no HTTP) and consumes the UI-message stream. */
  sendTurn(sessionId: string, message: string): Promise<TurnResult>;
}

export interface HarnessHandle {
  ctx: EvalCtx;
  close(): Promise<void>;
}

/**
 * Build a fresh, isolated harness context: a brand-new PGlite database in a
 * temp dir, migrated + seeded (masters, design rules, prices — the same
 * `seedDatabase` every db/worker test uses), with the dev user row ensured.
 * Isolating per-run means budget/contradiction/ledger assertions never leak
 * across scenarios sharing one process.
 */
export async function createHarnessCtx(models: ChatModels): Promise<HarnessHandle> {
  const pgliteDir = await mkdtemp(join(tmpdir(), "pebble-chat-eval-"));
  const handle: DbHandle = await createDb({ pglite: true, pgliteDir });
  await migrateDb(handle);
  await seedDatabase(handle.db);
  const db = handle.db as unknown as Db;
  const user = await ensureDevUser(db);
  // Defensive: force the master digest to re-render against THIS db's
  // snapshot at least once (the module-level cache in digest-cache.ts is
  // process-scoped, so it would otherwise be reused verbatim across the
  // sequential per-scenario dbs — harmless since the seed is identical, but
  // explicit is better than relying on that).
  resetDigestCache();

  const ctx: EvalCtx = {
    db,
    models,
    user,
    makeSession: () => `eval-${randomUUID()}`,
    sendTurn: async (sessionId, message) => {
      const response = await runAgentTurn(
        { db, models },
        { sessionId, message, user: { firebaseUid: user.firebaseUid, role: user.role } },
      );
      const clone = response.clone();
      const consumed =
        response.status === 200 ? await consumeUiMessageStream(clone) : await consumeJsonResponse(clone);
      return { text: consumed.text, parts: consumed.parts, response };
    },
  };

  return {
    ctx,
    close: async () => {
      await handle.close();
    },
  };
}

// ─── Cost / wall measurement ──────────────────────────────────────────────

/** Total estimated USD spend across every llm_calls row ever attributed to this user in this db. */
export async function caseCostUsd(db: Db, userId: string): Promise<number> {
  return sumLlmCostSince(db, { userId, sinceISO: new Date(0).toISOString() });
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; wallMs: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, wallMs: Date.now() - start };
}

// ─── Cache-prefix tripwire (WP10) ──────────────────────────────────────────

export interface CacheTripwireResult {
  ok: boolean;
  cacheReadTokens: number | null;
  note: string;
}

/**
 * The regression tripwire for prompt-cache prefix busting. ANY scenario that
 * runs 2+ turns on the same session should call this after its last turn: a
 * second-or-later turn that reads ZERO tokens from the prompt cache means the
 * cached prefix (persona → module fragments/policy → digest, breakpoint 1;
 * the previous turn's user message, breakpoint 2) was silently invalidated —
 * a reordered message, an accidentally-mutated digest, a dropped
 * `cache_control` breakpoint, or a ttl mismatch between the two breakpoints
 * (WP10) — which would quietly multiply live cost on every turn forever. Live
 * numbers only: this reads whatever the real Anthropic response actually
 * reported on `llm_calls.cache_read_tokens` for the LAST call ledgered on
 * `sessionId` (highest ULID id = most recent, see `getLatestLlmCallForSession`).
 */
export async function assertCachePrefixIntact(db: Db, sessionId: string): Promise<CacheTripwireResult> {
  const last = await getLatestLlmCallForSession(db, sessionId);
  const cacheReadTokens = last?.cacheReadTokens ?? null;
  const ok = (cacheReadTokens ?? 0) > 0;
  return {
    ok,
    cacheReadTokens,
    note: ok
      ? `cache prefix intact: last turn read ${cacheReadTokens} cache tokens`
      : `CACHE TRIPWIRE FAILED: last turn's llm_calls row read ${cacheReadTokens ?? 0} cache tokens — the cached prefix was likely busted`,
  };
}

// ─── Case result / scenario contract ──────────────────────────────────────

export interface CaseResult {
  pass: boolean;
  notes: string[];
}

export interface ConversationScenario {
  slug: string;
  description: string;
  run(ctx: EvalCtx): Promise<CaseResult>;
}

// ─── No-invented-numbers matcher ──────────────────────────────────────────

/**
 * Candidate "figure" tokens in assistant text: a ₹-prefixed amount, an
 * Indian-grouped number (with or without a decimal tail), a plain decimal, or
 * a whole number of 3+ digits (i.e. >= 100 — short 1-2 digit numbers are
 * almost always counts/floors/tiers, not figures, and are deliberately
 * excluded per the eval spec to avoid false hits).
 */
const NUMBER_TOKEN_RE =
  /₹\s?\d[\d,]*(?:\.\d+)?|\b\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\b|\b\d+\.\d+\b|\b\d{3,}\b/g;

export function extractNumberTokens(text: string): string[] {
  return [...text.matchAll(NUMBER_TOKEN_RE)].map((m) => m[0]);
}

/**
 * All the acceptable normalized forms of one token to search for, so a rupee
 * figure with paise (e.g. "₹94,93,283.80") can be matched against a tool
 * result that (per this codebase's money convention — every amount is stored
 * and returned as an INTEGER PAISE field, e.g. `grandTotalPaise: 949328380`,
 * `packages/shared/src/money.ts`) carries the same figure as a bare integer
 * with no decimal point:
 *   - the digits with the decimal point kept ("9493283.80")
 *   - the digits with the decimal point removed ("949328380" — the paise form)
 *   - the integer part alone, decimals dropped ("9493283")
 */
function normalizedNumberForms(tok: string): string[] {
  const stripped = tok.replace(/₹/g, "").replace(/,/g, "").replace(/\s/g, "");
  const forms = new Set<string>([stripped]);
  if (stripped.includes(".")) {
    forms.add(stripped.replace(".", ""));
    forms.add(stripped.split(".")[0]!);
  }
  return [...forms];
}

/** Strip ₹ and thousands-commas from a haystack so normalized number substrings line up. */
function normalizeHaystack(text: string): string {
  return text.replace(/₹/g, "").replace(/,/g, "");
}

export interface NumberCheckResult {
  ok: boolean;
  checked: string[];
  invented: string[];
}

/**
 * Every ₹/decimal/large-whole-number token in `replyText` must appear
 * (normalized) somewhere in `haystacks` — tool outputs, the user's own words,
 * the master digest, or (per the persona's own hard rule — it is as
 * authoritative a source as the digest) the system persona/module-fragment
 * text. Tolerant by design (see `NUMBER_TOKEN_RE` + `normalizedNumberForms`):
 * this is a smell test for invented figures, not a character-exact audit.
 */
export function checkNoInventedNumbers(replyText: string, haystacks: string[]): NumberCheckResult {
  const normalizedHaystacks = haystacks.map(normalizeHaystack);
  const checked: string[] = [];
  const invented: string[] = [];
  for (const tok of extractNumberTokens(replyText)) {
    const forms = normalizedNumberForms(tok);
    checked.push(forms[0]!);
    const found = normalizedHaystacks.some((h) => forms.some((f) => h.includes(f)));
    if (!found) invented.push(tok);
  }
  return { ok: invented.length === 0, checked, invented };
}

/** The master-data digest text (rates, rules, standards) — a huge legitimate haystack for figures. */
export async function getDigestText(db: Db): Promise<string> {
  const digest = await getCachedDigest(db);
  return digest.digestBlock.content;
}

/**
 * The persona + Module-02 fragment text (`PEBBLE_PERSONA`,
 * `MODULE02_FRAGMENT`) — a legitimate haystack source for the numbers matcher.
 * The persona states fixed domain constants verbatim (e.g. "SITC = Supply ×
 * 1.43, acceptable band 1.35–1.51"); the model restating one of these is not
 * an invented figure, it is the system prompt speaking through the model.
 */
export function getPromptConstantsText(): string {
  return `${PEBBLE_PERSONA}\n\n${MODULE02_FRAGMENT}`;
}

// ─── Small db-facing helpers shared by scenarios ──────────────────────────

/**
 * The estimate row linked to an enquiry. There is no enquiry→estimate repo
 * function (the app only ever goes estimate→enquiry); mirrors the same
 * small-table select-then-filter-in-JS pattern `ai-services.ts` uses.
 */
export async function findEstimateForEnquiry(
  db: Db,
  enquiryId: string,
): Promise<{ estimateId: string; currentVersion: number } | null> {
  const rows = await db.select().from(schema.estimates);
  const row = rows.find((r) => r.enquiryId === enquiryId);
  return row ? { estimateId: row.estimateId, currentVersion: row.currentVersion } : null;
}

/** Every field in a SlotState is "missing" (the fresh-session baseline). */
export function allSlotsMissing(state: SlotState): boolean {
  return (Object.keys(state) as SlotField[]).every((f) => state[f].status === "missing");
}

/** Count of non-missing (proposed or confirmed) fields — used to assert capture "grows". */
export function capturedFieldCount(state: SlotState): number {
  return (Object.keys(state) as SlotField[]).filter((f) => state[f].status !== "missing").length;
}

/** Seed one past-estimate RAG chunk so a recall/curveball question has something real to retrieve. */
export async function seedPastEstimateChunk(
  db: Db,
  args: { filename: string; content: string },
): Promise<void> {
  const { id } = await registerSourceDocument(db, {
    filename: args.filename,
    storageUri: `eval://${encodeURIComponent(args.filename)}`,
    docType: "proposal",
  });
  await replaceDocChunks(db, id, [
    { chunkKind: "line_item", content: args.content, embedding: null, metadata: {} },
  ]);
}

/** Seed llm_calls rows on `sessionId` that sum to `costUsd` (the daily-budget-guard fixture). */
export async function seedLlmSpend(
  db: Db,
  args: { sessionId: string; costUsd: number; model?: string },
): Promise<void> {
  await insertLlmCall(db, {
    sessionId: args.sessionId,
    lane: "claude",
    model: args.model ?? "claude-sonnet-4-6",
    intent: "eval-seed",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: args.costUsd,
  });
}

/** A rule-code or standard-reference citation in reply text (e.g. "DL-FAS-001", "IS 2189"). */
export function citesRuleOrStandard(text: string): boolean {
  return /\bDL-[A-Za-z0-9]+-\d+\b/.test(text) || /\bIS\s?\d+\b/i.test(text);
}
