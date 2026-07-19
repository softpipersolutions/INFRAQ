import type { Material } from "@pebble/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  module02Toolset,
  type EnquiryStateSnapshot,
  type PebbleAiServices,
  type SlotField,
} from "../src/index";

/** ToolCallOptions stub — the tools ignore it, but execute requires the arg. */
const OPTS = { toolCallId: "t1", messages: [] } as never;
const SESSION = { sessionId: "sess-1" };

const SNAP: EnquiryStateSnapshot = {
  slots: {} as Record<SlotField, { status: "missing"; value: null }>,
  confirmed: [],
  proposed: [],
  missingRequired: [],
  issues: [],
  readyToConfirm: false,
  enquiryId: null,
  estimateId: null,
  advisoryNextStep: "capture is incomplete",
};

function stubServices(over: Partial<PebbleAiServices> = {}): PebbleAiServices {
  return {
    lookupMaterial: vi.fn(
      async (code: string): Promise<Material> => ({
        materialCode: code,
        materialName: "Smoke Detector",
        systemType: "FAS",
        category: "Detector",
        unitOfMeasure: "No.",
        active: true,
      }),
    ),
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
    // Phase C.5 state-machine ops.
    extractFields: vi.fn(async () => SNAP),
    createEnquiryFromState: vi.fn(async () => ({ ok: true as const, enquiryId: "GBE-ENQ-2026-002", estimateId: "GBE-EST-2026-002" })),
    getEnquiryState: vi.fn(async () => SNAP),
    repairEnquiryState: vi.fn(async () => ({ ok: true as const, snapshot: SNAP })),
    resetEnquiryCapture: vi.fn(async () => SNAP),
    prepareDocuments: vi.fn(async (estimateId: string) => ({ ok: true, estimateId, jobId: "job-1", status: "queued" })),
    ...over,
  };
}

const asZod = (schema: unknown) => schema as z.ZodType<Record<string, unknown>>;

describe("module02Toolset — surface", () => {
  it("exposes every Module-02 tool", () => {
    const { tools } = module02Toolset(stubServices(), SESSION);
    expect(Object.keys(tools).sort()).toEqual(
      [
        "create_enquiry",
        "explain_line",
        "extract_enquiry_fields",
        "get_current_price",
        "get_design_rules",
        "get_enquiry_state",
        "get_estimate_version",
        "list_makes_for_material",
        "lookup_material",
        "prepare_documents",
        "propose_line_edit",
        "repair_enquiry_state",
        "reset_enquiry_capture",
        "search_past_estimates",
        "update_enquiry_draft",
      ].sort(),
    );
  });

  it("declares the Module-02 policy + identity and leaves buildTurnContext unset", () => {
    const ts = module02Toolset(stubServices(), SESSION);
    expect(ts.id).toBe("module02");
    expect(ts.policy.confirmRequired).toEqual(["create_enquiry"]);
    expect(ts.policy.humanOnly).toEqual(["approve_estimate", "dispatch_quote"]);
    expect(ts.buildTurnContext).toBeUndefined();
    // The fragment carries the load-bearing domain rules.
    expect(ts.promptFragment).toMatch(/SITC = Supply × 1\.43/);
    expect(ts.promptFragment).toMatch(/1\.35–1\.51/);
    expect(ts.promptFragment).toMatch(/userConfirmed/);
  });
});

describe("update_enquiry_draft — typed fields, injected sessionId", () => {
  it("does not accept a model-supplied sessionId (it is not in the schema)", () => {
    const { tools } = module02Toolset(stubServices(), SESSION);
    const parsed = asZod(tools.update_enquiry_draft!.inputSchema).safeParse({
      sessionId: "hacked",
      clientName: "Acme",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("sessionId" in parsed.data).toBe(false);
      expect(parsed.data.clientName).toBe("Acme");
    }
  });

  it("injects the bound sessionId and forwards the typed fields to the service", async () => {
    const services = stubServices();
    const { tools } = module02Toolset(services, SESSION);
    await tools.update_enquiry_draft!.execute!({ clientName: "Acme", floorsAbove: 4 }, OPTS);
    expect(services.updateEnquiryDraft).toHaveBeenCalledWith("sess-1", { clientName: "Acme", floorsAbove: 4 });
  });

  it("round-trips the extraction fields through the schema", () => {
    const { tools } = module02Toolset(stubServices(), SESSION);
    const parsed = asZod(tools.update_enquiry_draft!.inputSchema).safeParse({
      clientName: "Acme",
      buildingType: "Commercial",
      floorsAbove: 8,
      floorAreaSqm: 500,
      systemsRequired: ["FAS", "Sprinkler"],
      makePreference: "Standard",
      projectTier: 2,
    });
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });
});

describe("create_enquiry — safety upgrade", () => {
  it("has exactly the {userConfirmed: literal true} schema", () => {
    const { tools } = module02Toolset(stubServices(), SESSION);
    const schema = asZod(tools.create_enquiry!.inputSchema);
    expect(schema.safeParse({ userConfirmed: true }).success).toBe(true);
    expect(schema.safeParse({ userConfirmed: false }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    // No enquiry-field steering: extra fields are stripped, leaving only userConfirmed.
    const parsed = schema.safeParse({ userConfirmed: true, clientName: "Acme", floorsAbove: 9 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(Object.keys(parsed.data)).toEqual(["userConfirmed"]);
  });

  it("derives the record from state via createEnquiryFromState (never model-supplied values)", async () => {
    const services = stubServices();
    const { tools } = module02Toolset(services, SESSION);
    const result = await tools.create_enquiry!.execute!({ userConfirmed: true }, OPTS);
    expect(services.createEnquiryFromState).toHaveBeenCalledWith("sess-1");
    expect(result).toEqual({ ok: true, enquiryId: "GBE-ENQ-2026-002", estimateId: "GBE-EST-2026-002" });
  });

  it("passes a service refusal ({ok:false, issues}) straight through for the agent to fix", async () => {
    const services = stubServices({
      createEnquiryFromState: vi.fn(async () => ({ ok: false as const, issues: ["floorsAbove: Required"] })),
    });
    const { tools } = module02Toolset(services, SESSION);
    const result = await tools.create_enquiry!.execute!({ userConfirmed: true }, OPTS);
    expect(result).toEqual({ ok: false, issues: ["floorsAbove: Required"] });
  });
});

describe("new self-heal + document tools call the right service methods", () => {
  it("extract_enquiry_fields → services.extractFields(text)", async () => {
    const services = stubServices();
    const { tools } = module02Toolset(services, SESSION);
    await tools.extract_enquiry_fields!.execute!({ text: "long pasted email..." }, OPTS);
    expect(services.extractFields).toHaveBeenCalledWith("long pasted email...");
  });

  it("get_enquiry_state → services.getEnquiryState(sessionId)", async () => {
    const services = stubServices();
    const { tools } = module02Toolset(services, SESSION);
    await tools.get_enquiry_state!.execute!({}, OPTS);
    expect(services.getEnquiryState).toHaveBeenCalledWith("sess-1");
  });

  it("repair_enquiry_state → services.repairEnquiryState(sessionId, {set, clear})", async () => {
    const services = stubServices();
    const { tools } = module02Toolset(services, SESSION);
    const args = { set: { floorsAbove: 6 }, clear: ["projectTier"] as SlotField[] };
    await tools.repair_enquiry_state!.execute!(args, OPTS);
    expect(services.repairEnquiryState).toHaveBeenCalledWith("sess-1", args);
    // schema accepts a partial `set` and a SlotField-enum `clear`.
    const schema = asZod(tools.repair_enquiry_state!.inputSchema);
    expect(schema.safeParse({ set: { clientName: "Acme" }, clear: ["notes"] }).success).toBe(true);
    expect(schema.safeParse({ clear: ["not_a_field"] }).success).toBe(false);
  });

  it("reset_enquiry_capture requires confirm:true and calls resetEnquiryCapture(sessionId)", async () => {
    const services = stubServices();
    const { tools } = module02Toolset(services, SESSION);
    const schema = asZod(tools.reset_enquiry_capture!.inputSchema);
    expect(schema.safeParse({ confirm: true }).success).toBe(true);
    expect(schema.safeParse({ confirm: false }).success).toBe(false);
    await tools.reset_enquiry_capture!.execute!({ confirm: true }, OPTS);
    expect(services.resetEnquiryCapture).toHaveBeenCalledWith("sess-1");
  });

  it("prepare_documents → services.prepareDocuments(estimateId)", async () => {
    const services = stubServices();
    const { tools } = module02Toolset(services, SESSION);
    await tools.prepare_documents!.execute!({ estimateId: "GBE-EST-2026-002" }, OPTS);
    expect(services.prepareDocuments).toHaveBeenCalledWith("GBE-EST-2026-002");
  });

  it("read tools still delegate to the injected service", async () => {
    const services = stubServices();
    const { tools } = module02Toolset(services, SESSION);
    const result = await tools.lookup_material!.execute!({ materialCode: "FAS-SMK-001" }, OPTS);
    expect(services.lookupMaterial).toHaveBeenCalledWith("FAS-SMK-001");
    expect((result as { materialCode: string }).materialCode).toBe("FAS-SMK-001");
  });

  // Ported from the retired tools.test.ts (buildPebbleTools): propose stays
  // suggestion-only — the model can never apply an estimate edit.
  it("propose_line_edit is suggestion-only (never applied)", async () => {
    const { tools } = module02Toolset(stubServices(), SESSION);
    const result = (await tools.propose_line_edit!.execute!(
      { estimateId: "E1", lineUid: "u1", qty: 32, editReason: "recount" },
      OPTS,
    )) as { applied: boolean };
    expect(result.applied).toBe(false);
  });
});
