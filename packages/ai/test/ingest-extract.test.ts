import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { extractDocMeta, extractPageWindow, type DocMeta, type PageLines } from "../src/index";

/**
 * A minimal stub satisfying the LanguageModelV2 shape generateObject() calls
 * into (doGenerate). We can't import the LanguageModelV2 type itself (it
 * lives in @ai-sdk/provider, which packages/ai does not depend on directly —
 * only "ai" and "@ai-sdk/google" are declared dependencies), so we build a
 * structurally-matching object and cast it through LanguageModel, exactly as
 * production code would receive a real provider's model.
 */
interface CapturedCall {
  prompt: Array<{ role: string; content: unknown }>;
  responseFormat: unknown;
}

function stubModel(
  payload: unknown,
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {
    inputTokens: 1200,
    outputTokens: 340,
    totalTokens: 1540,
  },
) {
  const calls: CapturedCall[] = [];
  const model = {
    specificationVersion: "v2",
    provider: "test-provider",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: async (options: { prompt: CapturedCall["prompt"]; responseFormat: unknown }) => {
      calls.push({ prompt: options.prompt, responseFormat: options.responseFormat });
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

function findUserContentParts(calls: CapturedCall[]): Array<{ type: string; [k: string]: unknown }> {
  expect(calls).toHaveLength(1);
  const userMessage = calls[0]!.prompt.find((m) => m.role === "user");
  expect(userMessage).toBeDefined();
  return userMessage!.content as Array<{ type: string; [k: string]: unknown }>;
}

const CANNED_META: DocMeta = {
  clientName: null,
  projectName: "COMMERCIAL UNIT, EXPORIO BUILDING, LUCKNOW, UP",
  attention: "Yamini Sharma",
  docDateISO: "2025-12-26",
  revision: "02",
  sourceEntityGuess: "Greenberg Enterprises",
  docKind: "proposal",
  systemsMentioned: ["Sprinkler", "FAS"],
  sections: [{ title: "A. SPRINKLER SYSTEM", systemGuess: "Sprinkler" }],
  grandTotalRupees: 83909.8,
  gstMentioned: true,
  summary: "A fire-safety proposal for a sprinkler + FAS system.",
};

describe("extractDocMeta", () => {
  it("validates the model's object against docMetaSchema and returns it", async () => {
    const { model } = stubModel(CANNED_META);
    const result = await extractDocMeta({
      model,
      pdfBytes: new Uint8Array([1, 2, 3]),
      hints: { filename: "FF-149.pdf" },
    });
    expect(result.meta).toEqual(CANNED_META);
  });

  it("maps usage.inputTokens/outputTokens onto the returned usage", async () => {
    const { model } = stubModel(CANNED_META, { inputTokens: 5000, outputTokens: 800, totalTokens: 5800 });
    const result = await extractDocMeta({
      model,
      pdfBytes: new Uint8Array([9]),
      hints: { filename: "x.pdf" },
    });
    expect(result.usage).toEqual({ inputTokens: 5000, outputTokens: 800 });
  });

  it("defaults usage to 0 when the provider omits token counts", async () => {
    const { model } = stubModel(CANNED_META, { inputTokens: undefined, outputTokens: undefined });
    const result = await extractDocMeta({
      model,
      pdfBytes: new Uint8Array([9]),
      hints: { filename: "x.pdf" },
    });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("sends the PDF bytes as a file part alongside the prompt text", async () => {
    const { model, calls } = stubModel(CANNED_META);
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    await extractDocMeta({ model, pdfBytes, hints: { filename: "FF-149.pdf" } });

    const parts = findUserContentParts(calls);
    const filePart = parts.find((p) => p.type === "file") as { mediaType: string; data: Uint8Array } | undefined;
    const textPart = parts.find((p) => p.type === "text") as { text: string } | undefined;

    expect(filePart).toBeDefined();
    expect(filePart!.mediaType).toBe("application/pdf");
    expect(Array.from(filePart!.data)).toEqual(Array.from(pdfBytes));

    expect(textPart).toBeDefined();
    expect(textPart!.text).toContain("FF-149.pdf");
    expect(textPart!.text).toMatch(/entire document/i);
  });

  it("rejects when the model's object fails schema validation", async () => {
    const { model } = stubModel({ ...CANNED_META, docKind: "not-a-real-kind" });
    await expect(
      extractDocMeta({ model, pdfBytes: new Uint8Array([1]), hints: { filename: "x.pdf" } }),
    ).rejects.toThrow();
  });
});

const CANNED_LINES: PageLines = {
  lines: [
    {
      slNo: "A1",
      description: "SITC M.S. Pipe Class 'C' 50 mm - For Sprinkler Main Central Branch; Make - Jindal (ISI)",
      makeRaw: "Jindal (ISI)",
      qty: 6,
      unitRaw: "mtr",
      unitRateRupees: 590,
      rateKind: "SITC",
      amountRupees: 3540,
      section: "A. SPRINKLER SYSTEM",
      page: 1,
      confidence: 0.92,
    },
  ],
  termsText: null,
};

describe("extractPageWindow", () => {
  it("validates the model's object against pageLinesSchema and returns lines + termsText", async () => {
    const { model } = stubModel(CANNED_LINES);
    const result = await extractPageWindow({
      model,
      windowPdfBytes: new Uint8Array([1]),
      pageStart: 1,
      pageEnd: 2,
      sectionContext: [],
    });
    expect(result.lines).toEqual(CANNED_LINES.lines);
    expect(result.termsText).toBeNull();
  });

  it("maps usage and sends the window bytes as a file part with the page-range prompt", async () => {
    const { model, calls } = stubModel(CANNED_LINES, { inputTokens: 2000, outputTokens: 500, totalTokens: 2500 });
    const windowPdfBytes = new Uint8Array([5, 6, 7]);
    const result = await extractPageWindow({
      model,
      windowPdfBytes,
      pageStart: 7,
      pageEnd: 12,
      sectionContext: ["A. SPRINKLER SYSTEM"],
    });
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 500 });

    const parts = findUserContentParts(calls);
    const filePart = parts.find((p) => p.type === "file") as { mediaType: string; data: Uint8Array } | undefined;
    const textPart = parts.find((p) => p.type === "text") as { text: string } | undefined;

    expect(filePart!.mediaType).toBe("application/pdf");
    expect(Array.from(filePart!.data)).toEqual(Array.from(windowPdfBytes));
    expect(textPart!.text).toContain("pages 7-12");
    expect(textPart!.text).toContain("A. SPRINKLER SYSTEM");
  });

  it("propagates terms text when present", async () => {
    const withTerms: PageLines = { lines: [], termsText: "15% advance payment." };
    const { model } = stubModel(withTerms);
    const result = await extractPageWindow({
      model,
      windowPdfBytes: new Uint8Array([1]),
      pageStart: 1,
      pageEnd: 2,
      sectionContext: [],
    });
    expect(result.termsText).toBe("15% advance payment.");
    expect(result.lines).toEqual([]);
  });

  it("rejects when the model's object fails schema validation", async () => {
    const { model } = stubModel({ lines: [{ ...CANNED_LINES.lines[0], page: -1 }], termsText: null });
    await expect(
      extractPageWindow({
        model,
        windowPdfBytes: new Uint8Array([1]),
        pageStart: 1,
        pageEnd: 2,
        sectionContext: [],
      }),
    ).rejects.toThrow();
  });
});
