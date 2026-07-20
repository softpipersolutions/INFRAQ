import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ASK_USER_TOOL_NAME, buildAskUserTool } from "../src/index";

/**
 * The agent-core structured-clarification tool (Phase C.5 chat overhaul WP6).
 * A module-agnostic tool with NO executor — the call itself is the rendered
 * option menu, and its lack of a result ends the turn at the question.
 */

const asZod = (schema: unknown) => schema as z.ZodType<Record<string, unknown>>;

describe("buildAskUserTool", () => {
  it("has the reserved name and NO execute (its absence ends the turn at the question)", () => {
    expect(ASK_USER_TOOL_NAME).toBe("ask_user");
    const tool = buildAskUserTool();
    expect("execute" in tool && tool.execute).toBeFalsy();
    expect(tool.description).toMatch(/clarif|option|menu/i);
    expect(tool.inputSchema).toBeDefined();
  });

  it("accepts a well-formed clarification: question + 2 options + allowFreeText", () => {
    const schema = asZod(buildAskUserTool().inputSchema);
    const parsed = schema.safeParse({
      question: "Which building type is this?",
      options: [
        { label: "Commercial", detail: "offices, retail, mixed-use" },
        { label: "Residential" },
      ],
      allowFreeText: true,
    });
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("accepts up to 4 options", () => {
    const schema = asZod(buildAskUserTool().inputSchema);
    const parsed = schema.safeParse({
      question: "Which tier?",
      options: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }],
      allowFreeText: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("enforces 2–4 options (rejects 1 and 5) and a non-empty question", () => {
    const schema = asZod(buildAskUserTool().inputSchema);
    expect(
      schema.safeParse({ question: "Pick", options: [{ label: "only one" }], allowFreeText: false }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        question: "Pick",
        options: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }, { label: "e" }],
        allowFreeText: false,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ question: "", options: [{ label: "a" }, { label: "b" }], allowFreeText: false }).success,
    ).toBe(false);
  });

  it("enforces the label (1–60 chars) and detail (≤200) bounds and requires allowFreeText", () => {
    const schema = asZod(buildAskUserTool().inputSchema);
    // Empty label rejected.
    expect(
      schema.safeParse({ question: "Q", options: [{ label: "" }, { label: "b" }], allowFreeText: true }).success,
    ).toBe(false);
    // Over-long label rejected.
    expect(
      schema.safeParse({
        question: "Q",
        options: [{ label: "x".repeat(61) }, { label: "b" }],
        allowFreeText: true,
      }).success,
    ).toBe(false);
    // Over-long detail rejected.
    expect(
      schema.safeParse({
        question: "Q",
        options: [{ label: "a", detail: "d".repeat(201) }, { label: "b" }],
        allowFreeText: true,
      }).success,
    ).toBe(false);
    // Missing allowFreeText rejected (it is required, not optional).
    expect(
      schema.safeParse({ question: "Q", options: [{ label: "a" }, { label: "b" }] }).success,
    ).toBe(false);
  });
});
