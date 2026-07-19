import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import {
  buildVerifyPrompt,
  stagedVerdictSchema,
  verifyStagedRecord,
  type StagedVerdict,
} from "../src/index";

/**
 * Verification lane tests — pure prompt assertions + a scripted-stub round-trip
 * (mirrors ingest-extract.test.ts's LanguageModelV2-shaped stub, zero network),
 * plus schema-boundary checks that a malformed verdict is rejected.
 */

interface CapturedCall {
  prompt: Array<{ role: string; content: unknown }>;
}

function stubModel(
  payload: unknown,
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {
    inputTokens: 800,
    outputTokens: 120,
    totalTokens: 920,
  },
) {
  const calls: CapturedCall[] = [];
  const model = {
    specificationVersion: "v2",
    provider: "test-provider",
    modelId: "gemini-verify-test",
    supportedUrls: {},
    doGenerate: async (options: { prompt: CapturedCall["prompt"] }) => {
      calls.push({ prompt: options.prompt });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        finishReason: "stop",
        usage,
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("doStream not implemented in stub");
    },
  } as unknown as LanguageModel;
  return { model, calls };
}

function userText(calls: CapturedCall[]): string {
  expect(calls).toHaveLength(1);
  const userMessage = calls[0]!.prompt.find((m) => m.role === "user");
  expect(userMessage).toBeDefined();
  const parts = userMessage!.content as Array<{ type: string; text?: string }>;
  return parts.find((p) => p.type === "text")?.text ?? "";
}

const PROPOSED = {
  payloadVersion: 1,
  materialCode: "FAS-SMK-001",
  brandName: { raw: "Agni", normalized: "Agni Devices" },
  sellRupees: 1450,
  rateKind: "SITC",
  validFromISO: "2022-09-21T00:00:00.000Z",
  sourceText: "Photoelectric Smoke Detector; Make - Agni",
};

describe("buildVerifyPrompt", () => {
  it("frames a genuine audit and states it is a gate, not an editor", () => {
    const prompt = buildVerifyPrompt({
      targetMaster: "prices",
      proposed: PROPOSED,
      sourceText: "Photoelectric Smoke Detector; Make - Agni",
      filename: "FF-01 Test Plaza (21092022 R0).pdf",
      docDateISO: "2022-09-21",
    });
    expect(prompt).toMatch(/auditing a machine-extracted record/i);
    expect(prompt).toMatch(/gate, not an editor/i);
    expect(prompt).toMatch(/never invent corrections/i);
    // The three verdicts are all named.
    expect(prompt).toMatch(/approve/);
    expect(prompt).toMatch(/reject/);
    expect(prompt).toMatch(/unsure/);
    // Absurd-magnitude guidance with the concrete examples from the spec.
    expect(prompt).toContain("₹4,50,000");
    expect(prompt).toMatch(/pump priced at ₹12/);
    // Brand/unit checks are present.
    expect(prompt).toMatch(/brand claimed .* appears in the source text/i);
    expect(prompt).toMatch(/unit is consistent/i);
  });

  it("embeds the target master, filename, date, source line and pretty JSON record", () => {
    const prompt = buildVerifyPrompt({
      targetMaster: "prices",
      proposed: PROPOSED,
      sourceText: "Photoelectric Smoke Detector; Make - Agni",
      filename: "FF-01 Test Plaza (21092022 R0).pdf",
      docDateISO: "2022-09-21",
    });
    expect(prompt).toContain("Target master: prices");
    expect(prompt).toContain("FF-01 Test Plaza (21092022 R0).pdf");
    expect(prompt).toContain("2022-09-21");
    expect(prompt).toContain("Photoelectric Smoke Detector; Make - Agni");
    // Pretty-printed (2-space indented) JSON of the proposed record.
    expect(prompt).toContain(JSON.stringify(PROPOSED, null, 2));
    expect(prompt).toContain('"materialCode": "FAS-SMK-001"');
  });

  it("renders an unknown document date rather than null", () => {
    const prompt = buildVerifyPrompt({
      targetMaster: "makes",
      proposed: { payloadVersion: 1 },
      sourceText: "some line",
      filename: "x.pdf",
      docDateISO: null,
    });
    expect(prompt).toContain("Source document date: unknown");
  });
});

describe("verifyStagedRecord", () => {
  it("round-trips an approve verdict and maps token usage", async () => {
    const verdict: StagedVerdict = { verdict: "approve", confidence: 0.95, issues: [] };
    const { model, calls } = stubModel(verdict, { inputTokens: 700, outputTokens: 40 });
    const result = await verifyStagedRecord({
      model,
      targetMaster: "prices",
      proposed: PROPOSED,
      sourceText: PROPOSED.sourceText,
      filename: "FF-01.pdf",
      docDateISO: "2022-09-21",
    });
    expect(result.verdict).toBe("approve");
    expect(result.confidence).toBe(0.95);
    expect(result.issues).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 700, outputTokens: 40 });
    // The proposed record + source line reached the model.
    const text = userText(calls);
    expect(text).toContain(PROPOSED.sourceText);
    expect(text).toContain('"materialCode": "FAS-SMK-001"');
  });

  it("round-trips a reject verdict with issues", async () => {
    const verdict: StagedVerdict = {
      verdict: "reject",
      confidence: 0.9,
      issues: ["brand 'Agni' does not appear in the source text"],
    };
    const { model } = stubModel(verdict);
    const result = await verifyStagedRecord({
      model,
      targetMaster: "prices",
      proposed: PROPOSED,
      sourceText: "Photoelectric Smoke Detector (no make printed)",
      filename: "FF-01.pdf",
      docDateISO: null,
    });
    expect(result.verdict).toBe("reject");
    expect(result.issues).toHaveLength(1);
  });

  it("round-trips an unsure verdict", async () => {
    const verdict: StagedVerdict = { verdict: "unsure", confidence: 0.4, issues: ["price is borderline"] };
    const { model } = stubModel(verdict);
    const result = await verifyStagedRecord({
      model,
      targetMaster: "materials",
      proposed: PROPOSED,
      sourceText: PROPOSED.sourceText,
      filename: "FF-01.pdf",
      docDateISO: null,
    });
    expect(result.verdict).toBe("unsure");
  });

  it("defaults usage to 0 when the provider omits token counts", async () => {
    const { model } = stubModel(
      { verdict: "approve", confidence: 1, issues: [] },
      { inputTokens: undefined, outputTokens: undefined },
    );
    const result = await verifyStagedRecord({
      model,
      targetMaster: "makes",
      proposed: {},
      sourceText: "x",
      filename: "x.pdf",
      docDateISO: null,
    });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("rejects when the model returns an unknown verdict", async () => {
    const { model } = stubModel({ verdict: "maybe", confidence: 0.5, issues: [] });
    await expect(
      verifyStagedRecord({
        model,
        targetMaster: "prices",
        proposed: PROPOSED,
        sourceText: "x",
        filename: "x.pdf",
        docDateISO: null,
      }),
    ).rejects.toThrow();
  });
});

describe("stagedVerdictSchema", () => {
  it("accepts a well-formed verdict", () => {
    expect(stagedVerdictSchema.safeParse({ verdict: "approve", confidence: 0.8, issues: [] }).success).toBe(true);
    expect(
      stagedVerdictSchema.safeParse({ verdict: "reject", confidence: 0, issues: ["wrong item"] }).success,
    ).toBe(true);
  });

  it("rejects an out-of-range confidence", () => {
    expect(stagedVerdictSchema.safeParse({ verdict: "approve", confidence: 1.5, issues: [] }).success).toBe(false);
    expect(stagedVerdictSchema.safeParse({ verdict: "approve", confidence: -0.1, issues: [] }).success).toBe(false);
  });

  it("rejects an unknown verdict and a non-string issue", () => {
    expect(stagedVerdictSchema.safeParse({ verdict: "commit", confidence: 0.5, issues: [] }).success).toBe(false);
    expect(stagedVerdictSchema.safeParse({ verdict: "approve", confidence: 0.5, issues: [42] }).success).toBe(false);
  });
});
