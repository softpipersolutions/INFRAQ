import { describe, expect, it } from "vitest";
import {
  buildMemoryHandler,
  composeAgent,
  DEFAULT_MEMORY_CAPS,
  MEMORY_TOOL_NAME,
  memoryToolset,
  normalizeMemoryPath,
  type MemoryCommand,
  type MemoryStore,
  type MemoryStoreEntry,
  type MemoryStoreFile,
  type SystemBlock,
  type TurnContext,
} from "../src/index";

/**
 * The cross-session memory handler (WP9): adversarial path handling, cap
 * enforcement, command round-trips, and composition presence. A tiny in-memory
 * store stands in for the db repos (userId already bound by construction).
 */

// ─── In-memory store ─────────────────────────────────────────────────────────

function memStore(): MemoryStore & { dump: () => Map<string, string> } {
  const files = new Map<string, string>();
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  return {
    dump: () => files,
    async get(path): Promise<MemoryStoreFile | null> {
      if (!files.has(path)) return null;
      const content = files.get(path)!;
      return { path, content, sizeBytes: bytes(content) };
    },
    async list(): Promise<MemoryStoreEntry[]> {
      return [...files.entries()].map(([path, content]) => ({ path, sizeBytes: bytes(content) }));
    },
    async upsert(path, content) {
      files.set(path, content);
    },
    async remove(path) {
      return files.delete(path);
    },
    async rename(oldPath, newPath) {
      if (!files.has(oldPath)) return false;
      files.set(newPath, files.get(oldPath)!);
      files.delete(oldPath);
      return true;
    },
  };
}

function handlerWith(caps = DEFAULT_MEMORY_CAPS) {
  const store = memStore();
  const handle = buildMemoryHandler({ store, caps });
  return { store, handle };
}

// ─── Path safety (adversarial) ───────────────────────────────────────────────

describe("normalizeMemoryPath — rejects escapes, requires /memories", () => {
  const rejected: Array<[string, unknown]> = [
    ["parent traversal", "/memories/../etc/passwd"],
    ["deep traversal", "/memories/../../etc/shadow"],
    ["traversal mid-path", "/memories/sub/../../secret"],
    ["absolute outside", "/etc/passwd"],
    ["relative path", "memories/notes.md"],
    ["backslash separator", "\\memories\\notes.md"],
    ["backslash smuggled", "/memories/..\\..\\x"],
    ["null byte", "/memories/notes\0.md"],
    ["empty string", ""],
    ["root slash only", "/"],
    ["not memories root", "/memoriez/notes.md"],
    ["non-string", 42],
  ];
  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      const r = normalizeMemoryPath(input);
      expect(r.ok).toBe(false);
    });
  }

  it("accepts /memories root and normalizes files under it", () => {
    const root = normalizeMemoryPath("/memories");
    expect(root).toMatchObject({ ok: true, path: "/memories", isRoot: true });
    const file = normalizeMemoryPath("/memories/clients/acme.md");
    expect(file).toMatchObject({ ok: true, path: "/memories/clients/acme.md", isRoot: false });
    // Collapses `.` and double slashes.
    expect(normalizeMemoryPath("/memories/./a//b.md")).toMatchObject({
      ok: true,
      path: "/memories/a/b.md",
    });
  });
});

describe("handler — adversarial paths never write, return an Error string", () => {
  it("a traversal create is refused and nothing is stored", async () => {
    const { store, handle } = handlerWith();
    const out = await handle({ command: "create", path: "/memories/../evil.md", file_text: "x" });
    expect(out).toMatch(/Error/);
    expect(out).toMatch(/\.\.|under \/memories/);
    expect(store.dump().size).toBe(0);
  });

  it("a null-byte view is refused", async () => {
    const { handle } = handlerWith();
    const out = await handle({ command: "view", path: "/memories/a\0.md" });
    expect(out).toMatch(/null byte/i);
  });

  it("a backslash delete is refused", async () => {
    const { handle } = handlerWith();
    const out = await handle({ command: "delete", path: "\\memories\\a.md" });
    expect(out).toMatch(/backslash/i);
  });
});

// ─── Caps ────────────────────────────────────────────────────────────────────

describe("handler — caps are enforced with an instructive error (never throws)", () => {
  it("refuses a file over the per-file byte cap", async () => {
    const { store, handle } = handlerWith({ maxFileBytes: 16, maxFiles: 20, maxTotalBytes: 1024 });
    const out = await handle({ command: "create", path: "/memories/a.md", file_text: "x".repeat(17) });
    expect(out).toMatch(/per-file limit|over the 16-byte/);
    expect(store.dump().has("/memories/a.md")).toBe(false);
  });

  it("refuses creating past the file-count cap", async () => {
    const { store, handle } = handlerWith({ maxFileBytes: 4096, maxFiles: 2, maxTotalBytes: 65536 });
    await handle({ command: "create", path: "/memories/a.md", file_text: "a" });
    await handle({ command: "create", path: "/memories/b.md", file_text: "b" });
    const out = await handle({ command: "create", path: "/memories/c.md", file_text: "c" });
    expect(out).toMatch(/limit 2|memory files/);
    expect(store.dump().has("/memories/c.md")).toBe(false);
  });

  it("overwriting an existing file does NOT trip the count cap", async () => {
    const { handle } = handlerWith({ maxFileBytes: 4096, maxFiles: 1, maxTotalBytes: 65536 });
    await handle({ command: "create", path: "/memories/a.md", file_text: "a" });
    const out = await handle({ command: "create", path: "/memories/a.md", file_text: "a2" });
    expect(out).toMatch(/Updated/);
  });

  it("refuses a write that would exceed the total byte cap", async () => {
    const { store, handle } = handlerWith({ maxFileBytes: 4096, maxFiles: 20, maxTotalBytes: 20 });
    await handle({ command: "create", path: "/memories/a.md", file_text: "x".repeat(15) });
    const out = await handle({ command: "create", path: "/memories/b.md", file_text: "y".repeat(10) });
    expect(out).toMatch(/total|bring memory to/);
    expect(store.dump().has("/memories/b.md")).toBe(false);
  });
});

// ─── Command semantics (round-trips) ─────────────────────────────────────────

describe("handler — command round-trips", () => {
  it("create → view (file) returns numbered lines", async () => {
    const { handle } = handlerWith();
    await handle({ command: "create", path: "/memories/n.md", file_text: "line one\nline two" });
    const view = await handle({ command: "view", path: "/memories/n.md" });
    expect(view).toBe("1: line one\n2: line two");
  });

  it("view on the /memories root lists files with sizes", async () => {
    const { handle } = handlerWith();
    await handle({ command: "create", path: "/memories/a.md", file_text: "abc" });
    const listing = await handle({ command: "view", path: "/memories" });
    expect(listing).toMatch(/Directory \/memories/);
    expect(listing).toMatch(/\/memories\/a\.md \(3 bytes\)/);
  });

  it("view on an empty root says so", async () => {
    const { handle } = handlerWith();
    expect(await handle({ command: "view", path: "/memories" })).toMatch(/empty/);
  });

  it("view with a view_range windows the lines", async () => {
    const { handle } = handlerWith();
    await handle({ command: "create", path: "/memories/n.md", file_text: "a\nb\nc\nd" });
    expect(await handle({ command: "view", path: "/memories/n.md", view_range: [2, 3] })).toBe("2: b\n3: c");
  });

  it("str_replace edits a unique match; refuses missing / non-unique", async () => {
    const { store, handle } = handlerWith();
    await handle({ command: "create", path: "/memories/n.md", file_text: "make: Agni\nmake: Agni" });
    const dup = await handle({ command: "str_replace", path: "/memories/n.md", old_str: "make", new_str: "brand" });
    expect(dup).toMatch(/unique|matches/);

    await handle({ command: "create", path: "/memories/u.md", file_text: "prefers Agni make" });
    const ok = await handle({ command: "str_replace", path: "/memories/u.md", old_str: "Agni", new_str: "Ravel" });
    expect(ok).toMatch(/Edited/);
    expect(store.dump().get("/memories/u.md")).toBe("prefers Ravel make");

    const missing = await handle({ command: "str_replace", path: "/memories/u.md", old_str: "nope", new_str: "x" });
    expect(missing).toMatch(/not found/);
  });

  it("insert places text at a line index; out-of-range is refused", async () => {
    const { store, handle } = handlerWith();
    await handle({ command: "create", path: "/memories/n.md", file_text: "first\nthird" });
    const ok = await handle({ command: "insert", path: "/memories/n.md", insert_line: 1, insert_text: "second" });
    expect(ok).toMatch(/Inserted/);
    expect(store.dump().get("/memories/n.md")).toBe("first\nsecond\nthird");

    const bad = await handle({ command: "insert", path: "/memories/n.md", insert_line: 99, insert_text: "x" });
    expect(bad).toMatch(/out of range/);
  });

  it("delete removes the file; a second delete reports not found", async () => {
    const { store, handle } = handlerWith();
    await handle({ command: "create", path: "/memories/n.md", file_text: "x" });
    expect(await handle({ command: "delete", path: "/memories/n.md" })).toMatch(/Deleted/);
    expect(store.dump().has("/memories/n.md")).toBe(false);
    expect(await handle({ command: "delete", path: "/memories/n.md" })).toMatch(/Error.*to delete/);
  });

  it("rename moves content; a missing source is refused", async () => {
    const { store, handle } = handlerWith();
    await handle({ command: "create", path: "/memories/old.md", file_text: "keep" });
    expect(
      await handle({ command: "rename", old_path: "/memories/old.md", new_path: "/memories/new.md" }),
    ).toMatch(/Renamed/);
    expect(store.dump().has("/memories/old.md")).toBe(false);
    expect(store.dump().get("/memories/new.md")).toBe("keep");

    expect(
      await handle({ command: "rename", old_path: "/memories/gone.md", new_path: "/memories/x.md" }),
    ).toMatch(/Error.*to rename/);
  });

  it("writing to the /memories root (not a file) is refused", async () => {
    const { handle } = handlerWith();
    expect(await handle({ command: "create", path: "/memories", file_text: "x" })).toMatch(/Error/);
    expect(await handle({ command: "delete", path: "/memories" })).toMatch(/Error/);
  });

  it("view / str_replace on a non-existent file returns a clear error", async () => {
    const { handle } = handlerWith();
    expect(await handle({ command: "view", path: "/memories/missing.md" })).toMatch(/no memory file/i);
    expect(
      await handle({ command: "str_replace", path: "/memories/missing.md", old_str: "a", new_str: "b" }),
    ).toMatch(/no memory file/i);
  });
});

describe("handler — never throws even if the store fails", () => {
  it("returns an Error string instead of throwing when the store rejects", async () => {
    const brokenStore: MemoryStore = {
      get: async () => {
        throw new Error("db down");
      },
      list: async () => [],
      upsert: async () => {},
      remove: async () => false,
      rename: async () => false,
    };
    const handle = buildMemoryHandler({ store: brokenStore });
    const out = await handle({ command: "view", path: "/memories/a.md" } as MemoryCommand);
    expect(out).toMatch(/Error: memory operation failed/);
  });
});

// ─── Composition presence ────────────────────────────────────────────────────

const digestBlock: SystemBlock = {
  role: "system",
  content: "# masters",
  providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
};
const turn: TurnContext = { sessionId: "s1", userId: "u1", userRole: "estimator" };

describe("memoryToolset — composition", () => {
  it("exposes exactly one 'memory' tool with an execute callback", () => {
    const { handle } = handlerWith();
    const mod = memoryToolset(handle);
    expect(mod.id).toBe(MEMORY_TOOL_NAME);
    expect(Object.keys(mod.tools)).toEqual([MEMORY_TOOL_NAME]);
    const tool = mod.tools[MEMORY_TOOL_NAME] as { execute?: unknown; name?: string };
    expect(typeof tool.execute).toBe("function");
    expect(mod.policy).toEqual({ confirmRequired: [], humanOnly: [] });
  });

  it("is present in every composed turn (like ask_user)", async () => {
    const { handle } = handlerWith();
    const comp = await composeAgent({
      persona: "You are Pebble.",
      modules: [memoryToolset(handle)],
      digestBlock,
      turn,
    });
    expect(comp.tools.memory).toBeDefined();
    expect(comp.tools.ask_user).toBeDefined();
    // The memory fragment joins the cached prefix.
    expect(comp.systemBlocks[1]!.content).toMatch(/MEMORY/);
  });

  it("the tool's execute delegates to the bound handler (own-user store)", async () => {
    const { store, handle } = handlerWith();
    const mod = memoryToolset(handle);
    const tool = mod.tools[MEMORY_TOOL_NAME] as {
      execute: (input: unknown, opts: unknown) => Promise<string>;
    };
    const res = await tool.execute(
      { command: "create", path: "/memories/pref.md", file_text: "likes Agni" },
      { toolCallId: "t1", messages: [] },
    );
    expect(res).toMatch(/Created/);
    expect(store.dump().get("/memories/pref.md")).toBe("likes Agni");
  });
});
