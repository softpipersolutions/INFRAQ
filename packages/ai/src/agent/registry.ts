import type { Tool } from "ai";
import type { SystemBlock } from "../prompts";
import { ASK_USER_TOOL_NAME, buildAskUserTool } from "./ask-user";

/**
 * The module-agnostic agent core (Phase C.5 — the ERP seam).
 *
 * This is an interface plus one pure compose function, deliberately NOT a
 * framework. A `ModuleToolset` is everything one INFRAQ module contributes to a
 * chat turn: a prompt fragment for the cached prefix, a bag of request-bound
 * tools, and its safety policy. `composeAgent` folds any number of modules,
 * a persona and the master-data digest into the ordered system blocks and the
 * unified tool set that `streamText` consumes. Module 02 (fire-safety estimates)
 * is the first toolset; future modules are just more toolsets.
 *
 * MCP seam (documented, not built here): a `ModuleToolset` says nothing about
 * where its tools come from. Today Module 02's tools are thin wrappers over
 * in-process services; a future external module can supply a `tools` record
 * whose executors are backed by an MCP client, without any change to this
 * interface or to `composeAgent`. `packages/mcp` remains the OUTBOUND surface
 * (exposing Pebble's tools to other hosts); this seam is the inbound mirror.
 */

/** Per-turn context handed to a module when it builds its fresh (never-cached) block. */
export interface TurnContext {
  sessionId: string;
  userId: string;
  userRole: string | null;
}

export interface ModuleToolset {
  id: string;
  title: string;
  /** Joins the CACHED prefix (persona → fragments/policy → digest). */
  promptFragment: string;
  /** Tools bound to this request's services. */
  tools: Record<string, Tool>;
  policy: {
    /** Tools that require an explicit user confirmation before use (e.g. create_enquiry). */
    confirmRequired: string[];
    /** Actions the app reserves for a human — never exposed as a tool (e.g. approve/dispatch). */
    humanOnly: string[];
  };
  /**
   * Optional fresh, per-turn context block (NEVER cached). Return null to
   * contribute nothing this turn. Module 02 leaves this unset — the /api/chat
   * route builds the session-state block via `agent/context.ts` directly.
   */
  buildTurnContext?(ctx: TurnContext): Promise<string | null>;
}

export interface AgentComposition {
  /** Ordered system blocks: persona → module fragments + policy digest → master digest (last, cached). */
  systemBlocks: SystemBlock[];
  /** Resolved `buildTurnContext` outputs (nulls dropped), in module order. */
  turnContextBlocks: string[];
  /**
   * Union of every module's tools, plus the agent-core `ask_user` clarification
   * tool. A `${moduleId}:` prefix is applied ONLY on a name collision between
   * modules; `ask_user` is reserved for the core and no module may define it.
   */
  tools: Record<string, Tool>;
}

/**
 * Compose the persona, modules and digest into the system blocks + tool union
 * for one agent turn.
 *
 * Block order is load-bearing for prompt caching:
 *   1. persona           — plain system block
 *   2. module fragments + a generated policy digest — plain system block
 *   3. digestBlock       — LAST, and the ONLY block carrying the cache_control
 *      breakpoint, so the whole prefix (persona + fragments + policy + digest)
 *      caches together.
 *
 * The digest block MUST carry `providerOptions` (the Anthropic ephemeral cache
 * breakpoint); we assert it so a mis-ordered or breakpoint-less digest can never
 * silently defeat caching.
 */
export async function composeAgent(opts: {
  persona: string;
  modules: ModuleToolset[];
  digestBlock: SystemBlock;
  turn: TurnContext;
}): Promise<AgentComposition> {
  const { persona, modules, digestBlock, turn } = opts;

  if (!digestBlock.providerOptions?.anthropic?.cacheControl) {
    throw new Error(
      "composeAgent: digestBlock must carry the cache_control breakpoint " +
        "(providerOptions.anthropic.cacheControl) and be the last system block so the whole prefix caches.",
    );
  }

  const fragmentsAndPolicy = [
    ...modules.map((m) => m.promptFragment.trim()).filter((f) => f.length > 0),
    buildPolicyDigest(modules),
  ].join("\n\n");

  const systemBlocks: SystemBlock[] = [
    { role: "system", content: persona },
    { role: "system", content: fragmentsAndPolicy },
    digestBlock,
  ];

  // Resolve fresh per-turn blocks in module order; drop nulls/undefined.
  const resolved = await Promise.all(
    modules.map((m) => (m.buildTurnContext ? m.buildTurnContext(turn) : Promise.resolve(null))),
  );
  const turnContextBlocks = resolved.filter((b): b is string => b != null && b.length > 0);

  return { systemBlocks, turnContextBlocks, tools: composeTools(modules) };
}

/**
 * A short, generated safety digest for the prefix. It names the human-only
 * actions across all modules (the model has no tool for them) and the tools that
 * require an explicit user confirmation first.
 */
export function buildPolicyDigest(modules: ModuleToolset[]): string {
  const humanOnly = dedupe(modules.flatMap((m) => m.policy.humanOnly));
  const confirmRequired = dedupe(modules.flatMap((m) => m.policy.confirmRequired));

  const lines: string[] = [];
  const humanOnlyList = humanOnly.length ? humanOnly.join(", ") : "(none)";
  lines.push(
    `Human-only actions in the app: ${humanOnlyList}. You have no tool for these — if asked, point the user to the button in the app.`,
  );
  if (confirmRequired.length) {
    lines.push(
      `These tools require an explicit user confirmation first: ${confirmRequired.join(", ")}. Restate the record and get a clear yes before you call them.`,
    );
  }
  lines.push(
    `Clarification questions go through ${ASK_USER_TOOL_NAME} (a short option menu the user taps) — at most one per turn, and never to confirm enquiry creation.`,
  );
  return lines.join("\n");
}

/**
 * Union every module's tools and add the agent-core `ask_user` clarification
 * tool. A tool key is prefixed with `${moduleId}:` ONLY when its bare name
 * collides across modules; `ask_user` is reserved for the core, so we assert no
 * module ever defines a tool of that name.
 */
function composeTools(modules: ModuleToolset[]): Record<string, Tool> {
  for (const m of modules) {
    if (ASK_USER_TOOL_NAME in m.tools) {
      throw new Error(
        `composeAgent: module "${m.id}" defines a tool named "${ASK_USER_TOOL_NAME}", which is reserved for the agent-core clarification tool.`,
      );
    }
  }

  const counts = new Map<string, number>();
  for (const m of modules) {
    for (const name of Object.keys(m.tools)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const tools: Record<string, Tool> = {};
  for (const m of modules) {
    for (const [name, t] of Object.entries(m.tools)) {
      const key = (counts.get(name) ?? 0) > 1 ? `${m.id}:${name}` : name;
      tools[key] = t;
    }
  }
  tools[ASK_USER_TOOL_NAME] = buildAskUserTool();
  return tools;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
