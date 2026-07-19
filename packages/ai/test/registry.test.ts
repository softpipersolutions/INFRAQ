import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildPolicyDigest,
  composeAgent,
  type ModuleToolset,
  type SystemBlock,
  type TurnContext,
} from "../src/index";

const PERSONA = "You are Pebble.";

const digestBlock: SystemBlock = {
  role: "system",
  content: "# Greenberg master data",
  providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
};

const turn: TurnContext = { sessionId: "s1", userId: "u1", userRole: "estimator" };

const noopTool = () => tool({ description: "x", inputSchema: z.object({}), execute: async () => null });

function mod(part: Partial<ModuleToolset> & { id: string }): ModuleToolset {
  return {
    title: part.title ?? part.id,
    promptFragment: part.promptFragment ?? `fragment for ${part.id}`,
    tools: part.tools ?? {},
    policy: part.policy ?? { confirmRequired: [], humanOnly: [] },
    buildTurnContext: part.buildTurnContext,
    id: part.id,
  };
}

describe("composeAgent — system block order", () => {
  it("orders persona → fragments+policy → digest LAST with the cache breakpoint", async () => {
    const comp = await composeAgent({
      persona: PERSONA,
      modules: [mod({ id: "module02", promptFragment: "M02 guidance" })],
      digestBlock,
      turn,
    });

    expect(comp.systemBlocks).toHaveLength(3);
    expect(comp.systemBlocks[0]!.content).toBe(PERSONA);
    expect(comp.systemBlocks[0]!.providerOptions).toBeUndefined();

    // Middle block carries the module fragment + generated policy digest.
    expect(comp.systemBlocks[1]!.content).toContain("M02 guidance");
    expect(comp.systemBlocks[1]!.providerOptions).toBeUndefined();

    // The digest block is LAST and is the only one with the cache breakpoint.
    const last = comp.systemBlocks[comp.systemBlocks.length - 1]!;
    expect(last).toBe(digestBlock);
    expect(last.providerOptions?.anthropic?.cacheControl?.type).toBe("ephemeral");
  });

  it("throws if the digest block lacks the cache_control breakpoint", async () => {
    const bad: SystemBlock = { role: "system", content: "# masters" };
    await expect(
      composeAgent({ persona: PERSONA, modules: [mod({ id: "m" })], digestBlock: bad, turn }),
    ).rejects.toThrow(/cache_control|providerOptions/i);
  });
});

describe("composeAgent — tool union + collision prefixing", () => {
  it("keeps unique tool names bare and prefixes ONLY colliding names with the module id", async () => {
    const a = mod({ id: "modA", tools: { create_enquiry: noopTool(), lookup_material: noopTool() } });
    const b = mod({ id: "modB", tools: { create_enquiry: noopTool(), search_history: noopTool() } });

    const comp = await composeAgent({ persona: PERSONA, modules: [a, b], digestBlock, turn });

    expect(Object.keys(comp.tools).sort()).toEqual(
      ["modA:create_enquiry", "modB:create_enquiry", "lookup_material", "search_history"].sort(),
    );
    // The bare, non-colliding names are present unprefixed.
    expect(comp.tools.lookup_material).toBeDefined();
    expect(comp.tools.search_history).toBeDefined();
    // The colliding name is not present bare.
    expect(comp.tools.create_enquiry).toBeUndefined();
  });

  it("a single module's tools are all bare (no collisions)", async () => {
    const only = mod({ id: "module02", tools: { create_enquiry: noopTool(), get_enquiry_state: noopTool() } });
    const comp = await composeAgent({ persona: PERSONA, modules: [only], digestBlock, turn });
    expect(Object.keys(comp.tools).sort()).toEqual(["create_enquiry", "get_enquiry_state"]);
  });
});

describe("buildPolicyDigest", () => {
  it("names human-only actions with the button pointer and lists confirm-required tools", () => {
    const digest = buildPolicyDigest([
      mod({
        id: "module02",
        policy: { confirmRequired: ["create_enquiry"], humanOnly: ["approve_estimate", "dispatch_quote"] },
      }),
    ]);
    expect(digest).toContain("Human-only actions in the app: approve_estimate, dispatch_quote");
    expect(digest).toMatch(/point the user to the button/i);
    expect(digest).toContain("create_enquiry");
    expect(digest).toMatch(/explicit user confirmation/i);
  });

  it("dedupes actions across modules and handles an empty human-only list", () => {
    const digest = buildPolicyDigest([
      mod({ id: "a", policy: { confirmRequired: [], humanOnly: ["approve_estimate"] } }),
      mod({ id: "b", policy: { confirmRequired: [], humanOnly: ["approve_estimate"] } }),
    ]);
    expect(digest.match(/approve_estimate/g)).toHaveLength(1);
  });
});

describe("composeAgent — turn context resolution", () => {
  it("collects buildTurnContext outputs in module order, dropping nulls and modules without a builder", async () => {
    const a = mod({ id: "a", buildTurnContext: async () => "block-A" });
    const b = mod({ id: "b", buildTurnContext: async () => null });
    const c = mod({ id: "c" }); // no builder
    const d = mod({ id: "d", buildTurnContext: async () => "block-D" });

    const comp = await composeAgent({ persona: PERSONA, modules: [a, b, c, d], digestBlock, turn });
    expect(comp.turnContextBlocks).toEqual(["block-A", "block-D"]);
  });

  it("passes the TurnContext through to the builder", async () => {
    let seen: TurnContext | null = null;
    const a = mod({
      id: "a",
      buildTurnContext: async (ctx) => {
        seen = ctx;
        return `session=${ctx.sessionId}`;
      },
    });
    const comp = await composeAgent({ persona: PERSONA, modules: [a], digestBlock, turn });
    expect(comp.turnContextBlocks).toEqual(["session=s1"]);
    expect(seen).toEqual(turn);
  });
});
