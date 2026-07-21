import { describe, expect, it } from "vitest";
import {
  attachmentsToolset,
  composeAgent,
  deferredToolNames,
  memoryToolset,
  module02Toolset,
  resolveToolSearchSupport,
  TOOL_SEARCH_UNSUPPORTED_WARNING,
  toolSearchEnabled,
  type AttachmentServices,
  type MemoryHandler,
  type PebbleAiServices,
  type SystemBlock,
  type TurnContext,
} from "../src/index";

/**
 * WP11 tool-search + defer_loading pilot. These tests pin the two invariants the
 * pilot must hold regardless of provider support: (1) the DEFERRED (cold) set
 * never contains a hot contract tool, and (2) with the flag off the composed
 * tool surface is byte-identical to today (no schema drift). The flag reader and
 * the installed-provider support probe are covered too — the probe doubles as an
 * executable record of the "unsupported by @ai-sdk/anthropic 2.0.8x" verdict.
 */

const digestBlock: SystemBlock = {
  role: "system",
  content: "# masters",
  providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
};
const turn: TurnContext = { sessionId: "s1", userId: "u1", userRole: "estimator" };

// Construction-only stubs: composeAgent never executes a tool, it only reads the
// tool KEYS + each module's hotTools, so the service closures are never called.
const aiServices = {} as unknown as PebbleAiServices;
const attachmentServices = {} as unknown as AttachmentServices;
const memoryHandler: MemoryHandler = async () => "";

/** The three production modules composed exactly as `runAgentTurn` does (skills lane OFF). */
async function composeProduction() {
  return composeAgent({
    persona: "You are Pebble.",
    modules: [
      module02Toolset(aiServices, { sessionId: "s1" }),
      attachmentsToolset(attachmentServices, { sessionId: "s1", skillsEnabled: false }),
      memoryToolset(memoryHandler),
    ],
    digestBlock,
    turn,
  });
}

describe("toolSearchEnabled — the pilot flag (default OFF)", () => {
  it("is on ONLY for the literal '1'", () => {
    expect(toolSearchEnabled({ PEBBLE_TOOL_SEARCH: "1" })).toBe(true);
    expect(toolSearchEnabled({ PEBBLE_TOOL_SEARCH: "0" })).toBe(false);
    expect(toolSearchEnabled({ PEBBLE_TOOL_SEARCH: "true" })).toBe(false);
    expect(toolSearchEnabled({})).toBe(false);
  });
});

describe("resolveToolSearchSupport — installed @ai-sdk/anthropic (2.0.8x)", () => {
  it("reports NO tool-search factory (the pilot is functionally off today)", () => {
    const support = resolveToolSearchSupport();
    expect(support.supported).toBe(false);
    expect(support.factoryName).toBeUndefined();
  });

  it("exposes the exact warning the flag logs when unsupported", () => {
    expect(TOOL_SEARCH_UNSUPPORTED_WARNING).toBe(
      "tool search unsupported by installed provider — flag ignored",
    );
  });
});

describe("deferredToolNames — the cold set never contains a hot tool", () => {
  it("excludes every hot contract tool and is never the whole tool set", async () => {
    const comp = await composeProduction();
    const hot = Object.entries(comp.toolMeta)
      .filter(([, m]) => m.hot)
      .map(([name]) => name);
    const deferred = deferredToolNames(comp);

    // The declared hot set across the three production modules + core.
    expect(hot.sort()).toEqual(
      [
        "update_enquiry_draft",
        "get_enquiry_state",
        "search_past_estimates",
        "create_enquiry",
        "list_attachments",
        "memory",
        "ask_user",
      ].sort(),
    );
    // No hot tool is ever in the deferred set.
    for (const h of hot) expect(deferred).not.toContain(h);
    // Deferred ∪ hot partitions the tool set, and ≥1 tool stays non-deferred.
    expect([...deferred, ...hot].sort()).toEqual(Object.keys(comp.tools).sort());
    expect(deferred.length).toBeLessThan(Object.keys(comp.tools).length);
  });
});

describe("composition is byte-identical to today with the flag off (no schema drift)", () => {
  it("snapshots the exact composed tool names + order (skills lane off)", async () => {
    const comp = await composeProduction();
    // Order is load-bearing: modules fold in registration order, tools in each
    // module's own key order, ask_user appended last by the core.
    expect(Object.keys(comp.tools)).toEqual([
      // module02 (registration order)
      "lookup_material",
      "list_makes_for_material",
      "get_current_price",
      "search_past_estimates",
      "get_design_rules",
      "get_estimate_version",
      "explain_line",
      "propose_line_edit",
      "update_enquiry_draft",
      "extract_enquiry_fields",
      "create_enquiry",
      "get_enquiry_state",
      "repair_enquiry_state",
      "reset_enquiry_capture",
      "prepare_documents",
      // attachments (skills lane off → re-read tools only)
      "list_attachments",
      "read_attachment",
      // memory (core cross-session)
      "memory",
      // agent-core clarification tool, always last
      "ask_user",
    ]);
    // toolMeta is a parallel map over the SAME keys — never adds/removes a tool.
    expect(Object.keys(comp.toolMeta).sort()).toEqual(Object.keys(comp.tools).sort());
  });
});
