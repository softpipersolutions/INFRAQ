import type { EnquiryInput } from "@pebble/shared";
import { describe, expect, it, vi } from "vitest";
import { buildPebbleTools, type PebbleAiServices } from "../src/index";

/** ToolCallOptions stub — the tools ignore it, but execute requires the arg. */
const OPTS = { toolCallId: "t1", messages: [] } as never;

function stubServices(over: Partial<PebbleAiServices> = {}): PebbleAiServices {
  return {
    lookupMaterial: vi.fn(async (code: string) => ({
      materialCode: code,
      materialName: "Smoke Detector",
      systemType: "FAS",
      category: "Detector",
      unitOfMeasure: "No.",
      active: true,
    })),
    listMakesForMaterial: vi.fn(async () => []),
    getCurrentPrice: vi.fn(async () => null),
    searchPastEstimates: vi.fn(async () => []),
    getDesignRules: vi.fn(async () => []),
    updateEnquiryDraft: vi.fn(async () => ({ nextQuestion: null, complete: true })),
    createEnquiry: vi.fn(async () => ({ enquiryId: "GBE-ENQ-2026-001" })),
    getEstimateVersion: vi.fn(async () => null),
    explainLine: vi.fn(async () => null),
    proposeLineEdit: vi.fn(async (args) => ({
      estimateId: args.estimateId,
      lineUid: args.lineUid,
      proposed: { qty: args.qty },
      rationale: "site recount",
      applied: false as const,
    })),
    ...over,
  };
}

describe("buildPebbleTools", () => {
  it("exposes the full tool set", () => {
    const tools = buildPebbleTools(stubServices());
    expect(Object.keys(tools).sort()).toEqual(
      [
        "create_enquiry",
        "explain_line",
        "get_current_price",
        "get_design_rules",
        "get_estimate_version",
        "list_makes_for_material",
        "lookup_material",
        "propose_line_edit",
        "search_past_estimates",
        "update_enquiry_draft",
      ].sort(),
    );
  });

  it("lookup_material delegates to the injected service", async () => {
    const services = stubServices();
    const tools = buildPebbleTools(services);
    const result = await tools.lookup_material.execute!({ materialCode: "FAS-SMK-001" }, OPTS);
    expect(services.lookupMaterial).toHaveBeenCalledWith("FAS-SMK-001");
    expect((result as { materialCode: string }).materialCode).toBe("FAS-SMK-001");
  });

  it("create_enquiry validates via the shared schema before creating", async () => {
    const services = stubServices();
    const tools = buildPebbleTools(services);
    const input: EnquiryInput = {
      clientName: "Acme",
      projectName: "Mall",
      buildingType: "Commercial",
      floorsAbove: 4,
      floorAreaSqm: 450,
      systemsRequired: ["FAS"],
      makePreference: "As per Greenberg",
      applicableStandard: "IS",
      projectTier: 2,
      clientEmail: null,
      clientPhone: null,
      notes: null,
      source: "chat",
    };
    const result = await tools.create_enquiry.execute!(input, OPTS);
    expect((result as { enquiryId: string }).enquiryId).toBe("GBE-ENQ-2026-001");
  });

  it("propose_line_edit is suggestion-only (never applied)", async () => {
    const tools = buildPebbleTools(stubServices());
    const result = (await tools.propose_line_edit.execute!(
      { estimateId: "E1", lineUid: "u1", qty: 32, editReason: "recount" },
      OPTS,
    )) as { applied: boolean };
    expect(result.applied).toBe(false);
  });
});
