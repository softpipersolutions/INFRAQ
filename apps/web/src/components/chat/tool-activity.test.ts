import { describe, expect, it } from "vitest";
import {
  isCreateEnquirySuccessPart,
  isGenerateFileSuccessPart,
  isMemoryPart,
  isToolPart,
  memoryIndicator,
  toolIcon,
  toolLabel,
  toolNameFromPart,
  toolSummary,
  type ToolPart,
} from "./tool-activity";

/**
 * Pure-function coverage for the tool-activity labels/summaries/receipt gate
 * (Phase C.5 WP4). No React rendering here — apps/web has no jsdom/testing-
 * library, so <ToolActivityRow/>/<ReceiptCard/> are exercised via a live
 * browser screenshot instead (see the work report); this file locks down the
 * logic that decides *what* they show.
 */

describe("toolLabel", () => {
  it("has a human label for all 15 Module-02 tools", () => {
    const tools = [
      ["lookup_material", "Looked up material"],
      ["search_past_estimates", "Searched past quotes"],
      ["get_design_rules", "Checked design rules"],
      ["update_enquiry_draft", "Updated the enquiry draft"],
      ["extract_enquiry_fields", "Read the details"],
      ["create_enquiry", "Created the enquiry"],
      ["get_enquiry_state", "Checked capture state"],
      ["repair_enquiry_state", "Fixed the capture state"],
      ["reset_enquiry_capture", "Reset the capture"],
      ["prepare_documents", "Prepared documents"],
      ["get_current_price", "Checked a rate"],
      ["explain_line", "Pulled the line's audit trail"],
      ["get_estimate_version", "Opened the estimate"],
      ["list_makes_for_material", "Checked approved makes"],
      ["propose_line_edit", "Drafted an edit suggestion"],
    ] as const;
    for (const [toolName, label] of tools) {
      expect(toolLabel(toolName)).toBe(label);
    }
  });

  it("prettifies an unknown tool name as a fallback", () => {
    expect(toolLabel("some_future_tool")).toBe("Some future tool");
    expect(toolLabel("")).toBe("Used a tool");
  });
});

describe("toolIcon", () => {
  it("has an icon for all 15 Module-02 tools", () => {
    const tools = [
      "lookup_material",
      "search_past_estimates",
      "get_design_rules",
      "update_enquiry_draft",
      "extract_enquiry_fields",
      "create_enquiry",
      "get_enquiry_state",
      "repair_enquiry_state",
      "reset_enquiry_capture",
      "prepare_documents",
      "get_current_price",
      "explain_line",
      "get_estimate_version",
      "list_makes_for_material",
      "propose_line_edit",
    ];
    for (const toolName of tools) {
      expect(toolIcon(toolName)).toBeTypeOf("object");
    }
  });

  it("falls back to a default icon for an unknown tool", () => {
    expect(toolIcon("some_future_tool")).toBe(toolIcon("some_other_future_tool"));
  });
});

describe("toolSummary", () => {
  it("summarises get_design_rules from the first rule's code + standard reference", () => {
    const output = [
      { ruleCode: "DL-FAS-001", standardReference: "IS 2189 cl. 6.2" },
      { ruleCode: "DL-FAS-002", standardReference: "IS 2189 cl. 6.3" },
    ];
    expect(toolSummary("get_design_rules", output)).toBe("DL-FAS-001 — IS 2189 cl. 6.2");
  });

  it("summarises search_past_estimates from the first hit's sourceFilename", () => {
    const output = [{ sourceFilename: "acme-hq-2024.pdf", snippet: "...", score: 0.9 }];
    expect(toolSummary("search_past_estimates", output)).toBe("acme-hq-2024.pdf");
  });

  it("returns null for create_enquiry (handled by ReceiptCard instead)", () => {
    expect(toolSummary("create_enquiry", { ok: true, enquiryId: "E1", estimateId: "S1" })).toBeNull();
  });

  it("is defensive against unknown-shaped / garbage outputs and never throws", () => {
    const garbage: unknown[] = [
      undefined,
      null,
      42,
      "a string",
      true,
      [],
      {},
      { ruleCode: 123 }, // wrong type for the field
      [null, undefined, 1, "x"],
    ];
    for (const output of garbage) {
      for (const toolName of [
        "get_design_rules",
        "search_past_estimates",
        "lookup_material",
        "list_makes_for_material",
        "get_current_price",
        "get_estimate_version",
        "explain_line",
        "get_enquiry_state",
        "update_enquiry_draft",
        "prepare_documents",
        "totally_unknown_tool",
      ]) {
        expect(() => toolSummary(toolName, output)).not.toThrow();
      }
    }
  });

  it("formats get_current_price from sellingRatePaise as INR", () => {
    const summary = toolSummary("get_current_price", {
      priceId: "P1",
      materialCode: "FAS-SMK-001",
      makeCode: "HON-FAS",
      buyingRatePaise: 100000,
      sellingRatePaise: 143000,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    });
    expect(summary).toMatch(/1,430\.00/);
  });

  it("reports a null get_current_price output as no price on file", () => {
    expect(toolSummary("get_current_price", null)).toBe("No price on file");
  });
});

describe("isToolPart / toolNameFromPart", () => {
  it("recognises static tool-<name> parts", () => {
    const part = { type: "tool-get_design_rules", state: "output-available" };
    expect(isToolPart(part)).toBe(true);
    expect(toolNameFromPart(part as ToolPart)).toBe("get_design_rules");
  });

  it("recognises dynamic-tool parts via their toolName field", () => {
    const part = { type: "dynamic-tool", toolName: "lookup_material" };
    expect(isToolPart(part)).toBe(true);
    expect(toolNameFromPart(part as ToolPart)).toBe("lookup_material");
  });

  it("rejects text/other parts", () => {
    expect(isToolPart({ type: "text" })).toBe(false);
    expect(isToolPart({ type: "step-start" })).toBe(false);
  });
});

describe("isCreateEnquirySuccessPart", () => {
  it("is true only for a finished, successful create_enquiry part", () => {
    const success: ToolPart = {
      type: "tool-create_enquiry",
      state: "output-available",
      output: { ok: true, enquiryId: "ENQ-1", estimateId: "EST-1" },
    };
    expect(isCreateEnquirySuccessPart(success)).toBe(true);
  });

  it("is false for a refusal ({ok:false, issues})", () => {
    const refusal: ToolPart = {
      type: "tool-create_enquiry",
      state: "output-available",
      output: { ok: false, issues: ["missing required fields"] },
    };
    expect(isCreateEnquirySuccessPart(refusal)).toBe(false);
  });

  it("is false while still pending (no output yet)", () => {
    const pending: ToolPart = {
      type: "tool-create_enquiry",
      state: "input-available",
      input: { userConfirmed: true },
    };
    expect(isCreateEnquirySuccessPart(pending)).toBe(false);
  });

  it("is false for a different tool, even with an {ok:true} shaped output", () => {
    const otherTool: ToolPart = {
      type: "tool-prepare_documents",
      state: "output-available",
      output: { ok: true, estimateId: "EST-1" },
    };
    expect(isCreateEnquirySuccessPart(otherTool)).toBe(false);
  });
});

describe("isGenerateFileSuccessPart", () => {
  it("is true for a finished generate_file with an attachmentId", () => {
    const part: ToolPart = {
      type: "tool-generate_file",
      state: "output-available",
      output: { ok: true, attachmentId: "att-7", filename: "draft.xlsx", draft: true },
    };
    expect(isGenerateFileSuccessPart(part)).toBe(true);
  });

  it("is false for a failure ({ok:false, error})", () => {
    const part: ToolPart = {
      type: "tool-generate_file",
      state: "output-available",
      output: { ok: false, error: "container blew up" },
    };
    expect(isGenerateFileSuccessPart(part)).toBe(false);
  });

  it("is false when the attachmentId is missing", () => {
    const part: ToolPart = {
      type: "tool-generate_file",
      state: "output-available",
      output: { ok: true },
    };
    expect(isGenerateFileSuccessPart(part)).toBe(false);
  });
});

describe("toolSummary — generate_file / read_attachment", () => {
  it("generate_file success returns null (renders as a card)", () => {
    expect(toolSummary("generate_file", { ok: true, attachmentId: "a", filename: "f.xlsx" })).toBeNull();
  });

  it("generate_file failure surfaces the error string", () => {
    expect(toolSummary("generate_file", { ok: false, error: "no file produced" })).toBe("no file produced");
  });

  it("read_attachment summarises with the filename", () => {
    expect(toolSummary("read_attachment", { ok: true, filename: "notes.txt", text: "x" })).toBe("notes.txt");
  });

  it("list_attachments summarises the count", () => {
    expect(toolSummary("list_attachments", [{ attachmentId: "a" }, { attachmentId: "b" }])).toBe("2 files");
    expect(toolSummary("list_attachments", [])).toBe("No files uploaded yet");
  });
});

describe("memory indicator (WP9)", () => {
  it("isMemoryPart matches the memory tool part", () => {
    expect(isMemoryPart({ type: "tool-memory" })).toBe(true);
    expect(isMemoryPart({ type: "tool-lookup_material" })).toBe(false);
    expect(isMemoryPart({ type: "dynamic-tool", toolName: "memory" })).toBe(true);
  });

  it("view reads → 'Checked memory' with the path", () => {
    expect(memoryIndicator({ command: "view", path: "/memories/prefs.md" })).toEqual({
      label: "Checked memory",
      path: "/memories/prefs.md",
    });
  });

  it("writes → 'Updated memory' with the path", () => {
    for (const command of ["create", "str_replace", "insert", "delete"]) {
      expect(memoryIndicator({ command, path: "/memories/a.md" })).toEqual({
        label: "Updated memory",
        path: "/memories/a.md",
      });
    }
  });

  it("rename → 'Updated memory' using the new_path", () => {
    expect(memoryIndicator({ command: "rename", old_path: "/memories/o.md", new_path: "/memories/n.md" })).toEqual({
      label: "Updated memory",
      path: "/memories/n.md",
    });
  });

  it("view on the root has no path", () => {
    expect(memoryIndicator({ command: "view", path: "/memories" })).toEqual({
      label: "Checked memory",
      path: "/memories",
    });
  });

  it("is defensive against unknown-shaped input", () => {
    expect(memoryIndicator(null)).toEqual({ label: "Used memory", path: null });
    expect(memoryIndicator({})).toEqual({ label: "Used memory", path: null });
  });
});
