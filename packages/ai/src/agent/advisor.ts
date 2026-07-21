import { anthropic } from "@ai-sdk/anthropic";
import type { ToolSet } from "ai";
import { modelConfigFromEnv } from "../models";
import type { EscalationDecision } from "./escalation";

/**
 * WP12 — the advisor-tool PILOT seam (`PEBBLE_ADVISOR`, default OFF).
 *
 * THE IDEA. Anthropic's beta advisor tool (header
 * `anthropic-beta: advisor-tool-2026-03-01`) lets a Sonnet EXECUTOR consult an
 * Opus ADVISOR mid-generation inside ONE request, instead of the host switching
 * the whole turn to Opus. The advisor sub-inferences bill separately, surfacing
 * in `usage.iterations[]` (type `advisor_message`) at the advisor model's rate.
 * For our deterministic-escalation lane that means: on a turn the pre-check would
 * have escalated to Opus, keep the cheaper Sonnet executor and hand it an Opus
 * advisor for the hard reasoning only — cheaper than a full Opus turn.
 *
 * PROVIDER-SUPPORT VERDICT (verified against the installed dep). The pinned
 * `@ai-sdk/anthropic@2.0.86` (and 2.0.87) ships NO advisor tool factory:
 * `anthropic.tools` exposes only bash / codeExecution / computer / memory /
 * textEditor / webFetch / webSearch. It DOES model the advisor USAGE shape
 * (`AnthropicUsageIteration` with `type:"advisor_message"` on
 * `providerMetadata.anthropic.iterations`), which is why the LEDGERING half of
 * this pilot (`parseAdvisorIterations`) is real and testable today — but there
 * is no way to ATTACH the tool through the installed provider.
 *
 * So the pilot is IMPLEMENTED as a clean seam but is FUNCTIONALLY the
 * deterministic switch: with the flag on and an escalation, `resolveTurnStrategy`
 * finds no factory, logs `ADVISOR_UNSUPPORTED_WARNING` once, and returns the
 * exact Opus model-switch behaviour. We deliberately do NOT hand-roll raw
 * Anthropic streaming to force the beta — that waits for a provider that ships
 * the factory, at which point `resolveAdvisorSupport` flips to `supported` and
 * the advisor branch (below) attaches the tool with the executor kept on Sonnet.
 *
 * The beta HEADER (`chat-model.ts`) is wired independently of factory support:
 * with the flag on the provider always carries the beta header, so the day a
 * provider ships the factory the request is already beta-eligible.
 */

/** The env var that gates the pilot. Default OFF — only the literal "1" enables it. */
export const ADVISOR_ENV = "PEBBLE_ADVISOR";

/** The Anthropic beta header value that opts a request into the advisor tool. */
export const ADVISOR_BETA_HEADER = "advisor-tool-2026-03-01";

/** Logged (once per escalating turn) when the flag is on but the installed provider can't honour it. */
export const ADVISOR_UNSUPPORTED_WARNING =
  "advisor unsupported by installed provider — using model switch";

/** Read the pilot flag. Pilot is default OFF; only `PEBBLE_ADVISOR=1` turns it on. */
export function advisorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[ADVISOR_ENV] === "1";
}

/**
 * Merge the advisor beta value into an `anthropic-beta` header, preserving any
 * existing betas by comma-joining. Returns the headers UNCHANGED when the pilot
 * is off (so the header is ABSENT with the flag off — never an empty
 * `anthropic-beta`), and `undefined` stays `undefined` when there is nothing to
 * add. Used by `createChatModelsFromEnv` to build the provider's headers.
 */
export function withAdvisorBetaHeader(
  headers: Record<string, string> | undefined,
  enabled: boolean,
): Record<string, string> | undefined {
  if (!enabled) return headers;
  const existing = headers?.["anthropic-beta"];
  const merged =
    existing && existing.trim().length > 0 ? `${existing},${ADVISOR_BETA_HEADER}` : ADVISOR_BETA_HEADER;
  return { ...(headers ?? {}), "anthropic-beta": merged };
}

/**
 * Candidate factory names for Anthropic's advisor tool, newest first. The beta
 * server tool is `advisor_20260301`; the AI SDK exposes provider-defined tools
 * as camelCase-plus-date factories on `anthropic.tools` (e.g. `webSearch_20250305`,
 * `memory_20250818`), so the factory — WHEN a future provider version ships it —
 * will land under one of these keys. Probing by name (rather than a hard import)
 * means a provider bump activates support with zero code change here.
 */
const ADVISOR_FACTORY_CANDIDATES = ["advisor_20260301", "advisor"] as const;

/** Whether the installed `@ai-sdk/anthropic` exposes a usable advisor tool factory. */
export interface AdvisorSupport {
  supported: boolean;
  /** The `anthropic.tools` key that matched, when supported (for wiring/logging). */
  factoryName?: string;
}

/** The installed provider's tool-factory map (default source for `resolveAdvisorSupport`). */
function installedAdvisorTools(): Record<string, unknown> {
  return (anthropic as unknown as { tools?: Record<string, unknown> }).tools ?? {};
}

/**
 * Probe the INSTALLED `@ai-sdk/anthropic` for an advisor tool factory. Pure
 * (reads the imported provider's `tools` map, no network). Returns
 * `{supported:false}` on 2.0.86/2.0.87 — the current reality — and flips to
 * `{supported:true, factoryName}` automatically if a later provider adds it.
 * `tools` is injectable so a test can stub a supported provider.
 */
export function resolveAdvisorSupport(
  tools: Record<string, unknown> = installedAdvisorTools(),
): AdvisorSupport {
  for (const name of ADVISOR_FACTORY_CANDIDATES) {
    if (typeof tools[name] === "function") return { supported: true, factoryName: name };
  }
  return { supported: false };
}

/**
 * The resolved plan for a turn: which lane model runs the EXECUTOR, any extra
 * tools folded into the turn (the advisor tool, when active), and a ledger
 * intent-prefix override.
 */
export interface TurnStrategy {
  /** Executor lane selector — mapped to the concrete model instance in `chat-agent.ts`. */
  model: "default" | "opus";
  /** Extra tools folded into the turn — the advisor tool when attached, else empty. */
  extraTools: ToolSet;
  /** Ledger intent-prefix override — `"agent-advisor"` when the advisor is attached, else null. */
  intentPrefix: string | null;
}

export interface ResolveTurnStrategyOptions {
  /** Injectable tools map (default: installed `anthropic.tools`) — lets tests stub advisor support. */
  advisorTools?: Record<string, unknown>;
  /** Injectable warn sink (default: `console.warn` with a `[chat]` prefix). */
  warn?: (message: string) => void;
  /** Opus model id for the advisor tool (default: `modelConfigFromEnv(env).claudeOpus`). */
  advisorModelId?: string;
}

/**
 * Decide how this turn actually runs, given the deterministic escalation
 * decision and the pilot flag.
 *
 *   - flag OFF, or no escalation this turn → the plain deterministic behaviour
 *     (`model = escalation.model`, no extra tools, default labelling);
 *   - flag ON and the pre-check wants Opus, but the installed provider ships NO
 *     advisor factory → log `ADVISOR_UNSUPPORTED_WARNING` once and fall back to
 *     the Opus model switch (behaviour identical to the flag-off Opus path);
 *   - flag ON, Opus wanted, AND a factory is present → keep the Sonnet executor,
 *     attach the Opus advisor tool (`max_uses` 2, ephemeral caching), and flag
 *     the ledger prefix `agent-advisor`.
 */
export function resolveTurnStrategy(
  escalation: Pick<EscalationDecision, "model">,
  env: Record<string, string | undefined> = process.env,
  opts: ResolveTurnStrategyOptions = {},
): TurnStrategy {
  // Flag off, or nothing to escalate → the plain deterministic behaviour.
  if (!advisorEnabled(env) || escalation.model !== "opus") {
    return { model: escalation.model, extraTools: {}, intentPrefix: null };
  }

  const support = resolveAdvisorSupport(opts.advisorTools);
  if (!support.supported) {
    const warn = opts.warn ?? ((m: string) => console.warn(`[chat] ${m}`));
    warn(ADVISOR_UNSUPPORTED_WARNING);
    // Deterministic-switch fallback — identical to the flag-off Opus path.
    return { model: "opus", extraTools: {}, intentPrefix: null };
  }

  // Supported: keep Sonnet, attach the Opus advisor tool.
  const advisorModelId = opts.advisorModelId ?? modelConfigFromEnv(env).claudeOpus;
  const tools = opts.advisorTools ?? installedAdvisorTools();
  const factory = tools[support.factoryName!] as ((cfg: unknown) => unknown) | undefined;
  const extraTools: ToolSet = {};
  if (typeof factory === "function") {
    extraTools.advisor = factory({
      model: advisorModelId,
      maxUses: 2,
      cacheControl: { type: "ephemeral" },
    }) as ToolSet[string];
  }
  return { model: "default", extraTools, intentPrefix: "agent-advisor" };
}

/**
 * One advisor sub-inference parsed defensively from a turn's provider metadata.
 * `model` is the advisor model id when the provider attributed it, else null
 * (the ledger falls back to the configured Opus id, which prices at the same
 * rate).
 */
export interface AdvisorIteration {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Parse advisor sub-inference iterations from an `onFinish` provider-metadata
 * blob. DEFENSIVE by construction — shape-checks every level and returns `[]`
 * on anything unexpected, so a normal (non-advisor) turn contributes no rows:
 *   - unwraps `providerMetadata.anthropic` (tolerating a nested `.usage`
 *     passthrough), requires an array of iterations;
 *   - keeps ONLY entries whose `type` is exactly `"advisor_message"`;
 *   - coerces `inputTokens`/`outputTokens` to finite numbers (0 otherwise) and
 *     `model` to a string (null otherwise).
 */
export function parseAdvisorIterations(providerMetadata: unknown): AdvisorIteration[] {
  const anthropicMeta = (providerMetadata as { anthropic?: unknown } | null | undefined)?.anthropic;
  if (!anthropicMeta || typeof anthropicMeta !== "object") return [];
  const rawIterations =
    (anthropicMeta as { iterations?: unknown }).iterations ??
    (anthropicMeta as { usage?: { iterations?: unknown } }).usage?.iterations;
  if (!Array.isArray(rawIterations)) return [];

  const out: AdvisorIteration[] = [];
  for (const entry of rawIterations) {
    if (!entry || typeof entry !== "object") continue;
    if ((entry as { type?: unknown }).type !== "advisor_message") continue;
    const inTok = (entry as { inputTokens?: unknown }).inputTokens;
    const outTok = (entry as { outputTokens?: unknown }).outputTokens;
    const model = (entry as { model?: unknown }).model;
    out.push({
      model: typeof model === "string" ? model : null,
      inputTokens: typeof inTok === "number" && Number.isFinite(inTok) ? inTok : 0,
      outputTokens: typeof outTok === "number" && Number.isFinite(outTok) ? outTok : 0,
    });
  }
  return out;
}
