import { generateObject, type LanguageModel } from "ai";
import { buildDocMetaPrompt, buildPageWindowPrompt, type DocMetaHints, type PageWindowArgs } from "./prompts";
import { docMetaSchema, pageLinesSchema, type DocMeta, type ExtractedLine } from "./schemas";

/**
 * The Phase B Gemini extraction lane's two model calls (spec section E):
 *   - extractDocMeta: one whole-document metadata pass
 *   - extractPageWindow: a page-windowed BOQ line-item pass
 *
 * Both take the model by injection (mirrors ../extract.ts) so orchestration
 * — retries, windowing, run bookkeeping — lives in the ingestion worker and
 * is testable here with a stubbed LanguageModel, no API key required.
 */

/** Token usage for one generateObject call, normalized to plain numbers for llm_calls logging. */
export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
}

function toUsage(usage: { inputTokens?: number; outputTokens?: number }): ExtractionUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

/** Extract whole-document metadata from a PDF's raw bytes. */
export async function extractDocMeta(args: {
  model: LanguageModel;
  pdfBytes: Uint8Array;
  hints: DocMetaHints;
}): Promise<{ meta: DocMeta; usage: ExtractionUsage }> {
  const prompt = buildDocMetaPrompt(args.hints);
  const { object, usage } = await generateObject({
    model: args.model,
    schema: docMetaSchema,
    messages: [
      {
        role: "user",
        content: [
          { type: "file", data: args.pdfBytes, mediaType: "application/pdf" },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  return { meta: object, usage: toUsage(usage) };
}

/** Extract BOQ line items (+ any Terms & Conditions text) from one page window. */
export async function extractPageWindow(args: {
  model: LanguageModel;
  windowPdfBytes: Uint8Array;
  pageStart: number;
  pageEnd: number;
  sectionContext: string[];
}): Promise<{ lines: ExtractedLine[]; termsText: string | null; usage: ExtractionUsage }> {
  const windowArgs: PageWindowArgs = {
    pageStart: args.pageStart,
    pageEnd: args.pageEnd,
    sectionContext: args.sectionContext,
  };
  const prompt = buildPageWindowPrompt(windowArgs);
  const { object, usage } = await generateObject({
    model: args.model,
    schema: pageLinesSchema,
    messages: [
      {
        role: "user",
        content: [
          { type: "file", data: args.windowPdfBytes, mediaType: "application/pdf" },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  return { lines: object.lines, termsText: object.termsText, usage: toUsage(usage) };
}
