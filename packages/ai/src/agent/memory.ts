import { anthropic } from "@ai-sdk/anthropic";
import type { Tool } from "ai";
import type { ModuleToolset } from "./registry";

/**
 * Cross-session memory (Chat overhaul WP9) — the agent-CORE memory toolset,
 * composed on every turn beside `module02` and `attachments` (like `ask_user`,
 * it belongs to the core, not any one module).
 *
 * ROUTE TAKEN — provider-defined tool. The installed `@ai-sdk/anthropic`
 * (2.0.87) ships Anthropic's client-side memory tool as a provider-defined
 * factory, `anthropic.tools.memory_20250818`. We use it with an `execute`
 * callback that delegates to `buildMemoryHandler`, so Claude drives the tool
 * with the exact command protocol it is trained on (`view` / `create` /
 * `str_replace` / `insert` / `delete` / `rename` over a virtual `/memories/`
 * tree) while WE own where the bytes live (a per-user Postgres store) and the
 * safety envelope. The SDK auto-attaches the required `context-management-
 * 2025-06-27` beta header when this tool is present, so no beta-header change is
 * needed in chat-model.ts. Because Claude already knows the command protocol, we
 * add only a short usage/content-policy fragment here (the substantive "what to
 * remember / never prices" policy lives in the persona MEMORY section).
 *
 * SECURITY. `buildMemoryHandler` normalizes every path, REQUIRES the `/memories`
 * prefix, and rejects traversal (`..`), absolute escapes, backslashes and null
 * bytes with a clear error STRING (never a throw). Per-user caps — 4 KB/file, 20
 * files, 64 KB total — are enforced before any write and, when exceeded, return
 * an instructive error string rather than throwing. The injected `store` is the
 * db repos with the authenticated userId pre-bound, so a handler can only ever
 * touch its own user's memory.
 */

export const MEMORY_TOOL_NAME = "memory";

/** The memory tool's command union (mirrors `anthropic.tools.memory_20250818`'s input). */
export type MemoryCommand =
  | { command: "view"; path: string; view_range?: [number, number] }
  | { command: "create"; path: string; file_text: string }
  | { command: "str_replace"; path: string; old_str: string; new_str: string }
  | { command: "insert"; path: string; insert_line: number; insert_text: string }
  | { command: "delete"; path: string }
  | { command: "rename"; old_path: string; new_path: string };

/** Per-user memory caps. Exceeding any of these returns an instructive error (never throws). */
export interface MemoryCaps {
  /** Max bytes in a single memory file. */
  maxFileBytes: number;
  /** Max number of memory files per user. */
  maxFiles: number;
  /** Max total bytes across all of a user's memory files. */
  maxTotalBytes: number;
}

export const DEFAULT_MEMORY_CAPS: MemoryCaps = {
  maxFileBytes: 4 * 1024,
  maxFiles: 20,
  maxTotalBytes: 64 * 1024,
};

/** One stored file, as the store reports it. */
export interface MemoryStoreFile {
  path: string;
  content: string;
  sizeBytes: number;
}

/** One directory-listing entry (path + size), as the store reports it. */
export interface MemoryStoreEntry {
  path: string;
  sizeBytes: number;
}

/**
 * The persistence surface the memory handler drives — the db repos with the
 * authenticated userId PRE-BOUND (so the handler never sees, and can never
 * cross, a user boundary). Implemented in apps/web over the memory repo.
 */
export interface MemoryStore {
  get(path: string): Promise<MemoryStoreFile | null>;
  list(): Promise<MemoryStoreEntry[]>;
  upsert(path: string, content: string): Promise<void>;
  /** True when a row was removed. */
  remove(path: string): Promise<boolean>;
  /** True when the move happened (old path existed). */
  rename(oldPath: string, newPath: string): Promise<boolean>;
}

/** A bound memory handler: parsed command in, result string out. Never throws. */
export type MemoryHandler = (command: MemoryCommand) => Promise<string>;

/** UTF-8 byte length — the unit every cap and stored size is measured in. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

const MEMORY_ROOT = "/memories";

type PathCheck =
  | { ok: true; path: string; isRoot: boolean }
  | { ok: false; error: string };

/**
 * Normalize + validate a memory path. REQUIRES the `/memories` prefix and
 * rejects every escape/traversal form with a clear message:
 *   - null bytes, backslashes (a Windows-path / smuggled-separator vector),
 *   - non-absolute paths (must start with `/`),
 *   - any `..` segment (parent-dir traversal), even after collapsing `.`.
 * `.` and empty segments (`//`) are collapsed. Returns the normalized path and
 * whether it is the `/memories` ROOT (the virtual directory itself).
 */
export function normalizeMemoryPath(raw: unknown): PathCheck {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "Error: a memory path is required (e.g. /memories/notes.md)." };
  }
  if (raw.includes("\0")) {
    return { ok: false, error: "Error: memory paths may not contain null bytes." };
  }
  if (raw.includes("\\")) {
    return { ok: false, error: "Error: memory paths may not contain backslashes; use '/' only." };
  }
  if (!raw.startsWith("/")) {
    return {
      ok: false,
      error: "Error: memory paths must be absolute and under /memories (e.g. /memories/notes.md).",
    };
  }
  const segments: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      return { ok: false, error: "Error: memory paths may not contain '..' segments." };
    }
    segments.push(seg);
  }
  if (segments.length === 0 || segments[0] !== "memories") {
    return { ok: false, error: "Error: memory paths must be under /memories (e.g. /memories/notes.md)." };
  }
  const normalized = "/" + segments.join("/");
  return { ok: true, path: normalized, isRoot: segments.length === 1 };
}

/** Render a `/memories` directory listing (path + size), sorted, with a friendly empty case. */
function renderListing(entries: MemoryStoreEntry[]): string {
  if (entries.length === 0) return `Directory ${MEMORY_ROOT} is empty.`;
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines = sorted.map((e) => `- ${e.path} (${e.sizeBytes} bytes)`);
  return [`Directory ${MEMORY_ROOT}:`, ...lines].join("\n");
}

/** Render a file's content as numbered lines (1-indexed), optionally windowed by an inclusive range. */
function renderNumbered(path: string, content: string, range?: [number, number]): string {
  const lines = content.split("\n");
  let start = 1;
  let end = lines.length;
  if (range) {
    start = Math.max(1, Math.floor(range[0]));
    end = range[1] === -1 ? lines.length : Math.min(lines.length, Math.floor(range[1]));
  }
  if (start > end) return `Error: invalid view_range [${range?.[0]}, ${range?.[1]}] for ${path}.`;
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    out.push(`${i}: ${lines[i - 1] ?? ""}`);
  }
  return out.join("\n");
}

/**
 * Build a memory handler bound to a per-user `store` and `caps`. The returned
 * function implements the six memory commands against the store, enforcing path
 * safety and the caps, and ALWAYS resolves to a result string — a value on
 * success, or an `Error: …` message on any rejection (so a bad call teaches the
 * model instead of crashing the turn).
 */
export function buildMemoryHandler(opts: { store: MemoryStore; caps?: MemoryCaps }): MemoryHandler {
  const { store } = opts;
  const caps = opts.caps ?? DEFAULT_MEMORY_CAPS;

  /** Cap check for a would-be write of `content` at `path`. Returns an error string, or null if OK. */
  async function checkCaps(path: string, content: string): Promise<string | null> {
    const newSize = byteLength(content);
    if (newSize > caps.maxFileBytes) {
      return `Error: that file is ${newSize} bytes, over the ${caps.maxFileBytes}-byte per-file limit. Keep memory entries short.`;
    }
    const entries = await store.list();
    const existing = entries.find((e) => e.path === path);
    const isNew = existing === undefined;
    const count = isNew ? entries.length + 1 : entries.length;
    if (count > caps.maxFiles) {
      return `Error: you already have ${entries.length} memory files (limit ${caps.maxFiles}). Delete or consolidate before adding more.`;
    }
    const total = entries.reduce((sum, e) => sum + e.sizeBytes, 0) - (existing?.sizeBytes ?? 0) + newSize;
    if (total > caps.maxTotalBytes) {
      return `Error: this would bring memory to ${total} bytes, over the ${caps.maxTotalBytes}-byte total. Prune older notes first.`;
    }
    return null;
  }

  return async (command: MemoryCommand): Promise<string> => {
    try {
      switch (command.command) {
        case "view": {
          const p = normalizeMemoryPath(command.path);
          if (!p.ok) return p.error;
          if (p.isRoot) return renderListing(await store.list());
          const file = await store.get(p.path);
          if (!file) return `Error: no memory file at ${p.path}.`;
          return renderNumbered(p.path, file.content, command.view_range);
        }

        case "create": {
          const p = normalizeMemoryPath(command.path);
          if (!p.ok) return p.error;
          if (p.isRoot) return `Error: ${MEMORY_ROOT} is the memory directory; create files under it (e.g. /memories/notes.md).`;
          const text = typeof command.file_text === "string" ? command.file_text : "";
          const capErr = await checkCaps(p.path, text);
          if (capErr) return capErr;
          const existed = (await store.get(p.path)) !== null;
          await store.upsert(p.path, text);
          return `${existed ? "Updated" : "Created"} ${p.path} (${byteLength(text)} bytes).`;
        }

        case "str_replace": {
          const p = normalizeMemoryPath(command.path);
          if (!p.ok) return p.error;
          const file = await store.get(p.path);
          if (!file) return `Error: no memory file at ${p.path}.`;
          const oldStr = command.old_str ?? "";
          if (oldStr.length === 0) return "Error: old_str must be a non-empty string to replace.";
          const occurrences = file.content.split(oldStr).length - 1;
          if (occurrences === 0) return `Error: old_str was not found in ${p.path}.`;
          if (occurrences > 1) {
            return `Error: old_str matches ${occurrences} places in ${p.path}; make it unique (add surrounding context).`;
          }
          const next = file.content.replace(oldStr, command.new_str ?? "");
          const capErr = await checkCaps(p.path, next);
          if (capErr) return capErr;
          await store.upsert(p.path, next);
          return `Edited ${p.path} (${byteLength(next)} bytes).`;
        }

        case "insert": {
          const p = normalizeMemoryPath(command.path);
          if (!p.ok) return p.error;
          const file = await store.get(p.path);
          if (!file) return `Error: no memory file at ${p.path}.`;
          const lines = file.content.split("\n");
          const at = command.insert_line;
          if (typeof at !== "number" || !Number.isInteger(at) || at < 0 || at > lines.length) {
            return `Error: insert_line ${String(at)} is out of range (0..${lines.length}) for ${p.path}.`;
          }
          const insertText = typeof command.insert_text === "string" ? command.insert_text : "";
          lines.splice(at, 0, insertText);
          const next = lines.join("\n");
          const capErr = await checkCaps(p.path, next);
          if (capErr) return capErr;
          await store.upsert(p.path, next);
          return `Inserted into ${p.path} at line ${at} (${byteLength(next)} bytes).`;
        }

        case "delete": {
          const p = normalizeMemoryPath(command.path);
          if (!p.ok) return p.error;
          if (p.isRoot) return `Error: cannot delete the memory root ${MEMORY_ROOT}; delete individual files.`;
          const removed = await store.remove(p.path);
          return removed ? `Deleted ${p.path}.` : `Error: no memory file at ${p.path} to delete.`;
        }

        case "rename": {
          const from = normalizeMemoryPath(command.old_path);
          if (!from.ok) return from.error;
          const to = normalizeMemoryPath(command.new_path);
          if (!to.ok) return to.error;
          if (from.isRoot || to.isRoot) {
            return `Error: ${MEMORY_ROOT} is the memory directory and cannot be renamed.`;
          }
          const moved = await store.rename(from.path, to.path);
          return moved ? `Renamed ${from.path} to ${to.path}.` : `Error: no memory file at ${from.path} to rename.`;
        }

        default:
          return "Error: unknown memory command.";
      }
    } catch (err) {
      // The handler never throws into the tool loop — surface a terse note instead.
      return `Error: memory operation failed (${err instanceof Error ? err.message : "unknown error"}).`;
    }
  };
}

/** Short cached-prefix fragment for the memory toolset (content policy lives in the persona). */
const MEMORY_FRAGMENT = `MEMORY
You have a private, cross-session memory at /memories (the memory tool). At the start of a task, when it would help, view /memories to recall durable facts about this user's clients and preferences. Write a durable learning back only when it will matter next time — keep each file short and well-named. NEVER store prices, rates or any figure in memory (the masters own pricing); store preferences, recurring specs and correction patterns instead.`;

/**
 * The agent-core memory toolset. Wraps Anthropic's provider-defined `memory`
 * tool with an `execute` that delegates to the bound `handler`. Composed on
 * every turn (see `runAgentTurn`); the handler carries the authenticated
 * userId + store, so the model can only ever reach its own user's memory.
 */
export function memoryToolset(handler: MemoryHandler): ModuleToolset {
  const memoryTool = anthropic.tools.memory_20250818({
    execute: async (input) => handler(input as MemoryCommand),
  }) as unknown as Tool;

  return {
    id: MEMORY_TOOL_NAME,
    title: "Cross-session memory",
    promptFragment: MEMORY_FRAGMENT,
    tools: { [MEMORY_TOOL_NAME]: memoryTool },
    policy: { confirmRequired: [], humanOnly: [] },
  };
}
