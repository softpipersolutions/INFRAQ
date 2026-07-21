import { anthropic } from "@ai-sdk/anthropic";
import type { AgentComposition } from "./registry";

/**
 * WP11 — the tool-search + `defer_loading` PILOT seam (`PEBBLE_TOOL_SEARCH`,
 * default OFF).
 *
 * THE IDEA. Anthropic's server-side tool-search tool
 * (`tool_search_tool_regex_20251119`, GA) lets a host mark most tools
 * `defer_loading:true` so they stay OUT of the request's cached tool prefix; the
 * model expands the handful it needs by searching (up to 5 `tool_reference`
 * results per turn). For a growing multi-module agent that trims the per-turn
 * tool-schema tokens without losing any capability. `registry.ts` already tags
 * every composed tool hot/cold (`AgentComposition.toolMeta`); this file turns
 * that tagging into a deferral decision.
 *
 * PROVIDER-SUPPORT VERDICT (verified against the installed dep). The pinned
 * `@ai-sdk/anthropic@2.0.86` (and 2.0.87) exposes NO tool-search tool factory
 * and NO `deferLoading`/`defer_loading` provider option — `anthropic.tools` ships
 * only bash/codeExecution/computer/memory/textEditor/webFetch/webSearch. So the
 * pilot is IMPLEMENTED as the Module-03 seam (hot/cold marking + flag plumbing +
 * this probe) but is FUNCTIONALLY OFF: with the flag on, `chat-agent.ts` logs
 * `TOOL_SEARCH_UNSUPPORTED_WARNING` once and streams with the full, undeferred
 * tool set exactly as when the flag is off. We deliberately do NOT hand-roll raw
 * Anthropic streaming to force the beta — that waits for a provider that ships
 * the factory, at which point `resolveToolSearchSupport` flips to `supported`
 * and the deferral (below) can be wired on with `deferredToolNames` already
 * giving the exact cold set.
 *
 * CACHE INVARIANT. Deferral only ever touches the *tool* list; the two prompt
 * cache breakpoints live on the master-digest SYSTEM block (`prompts.ts`) and
 * the per-turn USER message (`chat-agent.ts`) — neither is a tool — so enabling
 * the pilot cannot move a cache breakpoint onto a deferred position (a deferred
 * tool may not carry `cache_control`; ours never would).
 */

/** The env var that gates the pilot. Default OFF — only the literal "1" enables it. */
export const TOOL_SEARCH_ENV = "PEBBLE_TOOL_SEARCH";

/** Logged (once per turn) when the flag is on but the installed provider can't honour it. */
export const TOOL_SEARCH_UNSUPPORTED_WARNING =
  "tool search unsupported by installed provider — flag ignored";

/** Read the pilot flag. Pilot is default OFF; only `PEBBLE_TOOL_SEARCH=1` turns it on. */
export function toolSearchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[TOOL_SEARCH_ENV] === "1";
}

/**
 * Candidate factory names for Anthropic's server-side tool-search tool, newest
 * first. The GA server tool is `tool_search_tool_regex_20251119`; the AI SDK
 * exposes provider-defined tools as camelCase-plus-date factories on
 * `anthropic.tools` (e.g. `webSearch_20250305`, `memory_20250818`,
 * `webFetch_20250910`), so the factory — WHEN a future provider version ships it
 * — will land under one of these keys. Probing by name (rather than a hard
 * import) means a provider bump activates support with zero code change here.
 */
const TOOL_SEARCH_FACTORY_CANDIDATES = [
  "toolSearch_20251119",
  "toolSearchToolRegex_20251119",
  "toolSearch",
] as const;

/** Whether the installed `@ai-sdk/anthropic` exposes a usable tool-search tool factory. */
export interface ToolSearchSupport {
  supported: boolean;
  /** The `anthropic.tools` key that matched, when supported (for logging/wiring). */
  factoryName?: string;
}

/**
 * Probe the INSTALLED `@ai-sdk/anthropic` for a tool-search tool factory. Pure
 * (reads the imported provider's `tools` map, no network). Returns
 * `{supported:false}` on 2.0.86/2.0.87 — the current reality — and flips to
 * `{supported:true, factoryName}` automatically if a later provider adds it.
 */
export function resolveToolSearchSupport(): ToolSearchSupport {
  const tools = (anthropic as unknown as { tools?: Record<string, unknown> }).tools ?? {};
  for (const name of TOOL_SEARCH_FACTORY_CANDIDATES) {
    if (typeof tools[name] === "function") return { supported: true, factoryName: name };
  }
  return { supported: false };
}

/**
 * The COLD set: composed tool keys that would be marked `defer_loading:true`
 * when the pilot is active — every tool whose `toolMeta` is not `hot`. By
 * construction this EXCLUDES every hot tool (module contract tools + core
 * `ask_user`/`memory`), and since `ask_user` is always hot the result can never
 * be the whole tool set, honouring Anthropic's ">=1 non-deferred tool" rule.
 *
 * This is the ready-to-use input for the (future) supported branch in
 * `chat-agent.ts`: for each name here, clone the tool with
 * `providerOptions.anthropic.defer_loading = true` and add the tool-search tool
 * from `resolveToolSearchSupport().factoryName`. Today it is used only by the
 * composition test to prove the deferral set never contains a hot tool.
 */
export function deferredToolNames(comp: Pick<AgentComposition, "toolMeta">): string[] {
  return Object.entries(comp.toolMeta)
    .filter(([, meta]) => !meta.hot)
    .map(([name]) => name);
}
