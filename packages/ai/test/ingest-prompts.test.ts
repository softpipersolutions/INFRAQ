import { describe, expect, it } from "vitest";
import { PDF_EXTRACT_PROMPT_VERSION, buildDocMetaPrompt, buildPageWindowPrompt } from "../src/index";

describe("PDF_EXTRACT_PROMPT_VERSION", () => {
  it("is a stable, explicit version string", () => {
    expect(PDF_EXTRACT_PROMPT_VERSION).toBe("pdf-extract-v1");
  });
});

describe("buildDocMetaPrompt", () => {
  const hints = {
    filename: "FF-149 Experio Unit Fire Sprinkler System & FAS (26122025 R2).pdf",
    parsedFileRef: "FF-149",
    parsedDateISO: "2025-12-26",
    parsedRevision: "R2",
  };

  it("is pure/deterministic — identical input produces identical output", () => {
    expect(buildDocMetaPrompt(hints)).toBe(buildDocMetaPrompt({ ...hints }));
  });

  it("instructs reading the whole document before answering", () => {
    expect(buildDocMetaPrompt(hints)).toMatch(/entire document/i);
  });

  it("names the two known letterhead entities", () => {
    const prompt = buildDocMetaPrompt(hints);
    expect(prompt).toContain("Greenberg Enterprises");
    expect(prompt).toContain("Padmawati Enterprises");
  });

  it("prefers the printed date over the filename", () => {
    const prompt = buildDocMetaPrompt(hints);
    expect(prompt).toMatch(/PREFER the printed date/);
  });

  it("lists the exact docKind enum values", () => {
    const prompt = buildDocMetaPrompt(hints);
    expect(prompt).toContain('"proposal" | "rate_list" | "estimate" | "other"');
  });

  it("lists the five canonical systems for section guesses", () => {
    const prompt = buildDocMetaPrompt(hints);
    expect(prompt).toContain("FAS, Hydrant, Sprinkler, Extinguisher, Suppression");
  });

  it("caps the summary at 250 words", () => {
    expect(buildDocMetaPrompt(hints)).toMatch(/250 words or fewer/);
  });

  it("forbids computing/deriving numbers", () => {
    const prompt = buildDocMetaPrompt(hints);
    expect(prompt).toMatch(/EXACTLY as printed/);
    expect(prompt).toMatch(/Never compute/);
  });

  it("includes the filename and filename-derived hints when provided", () => {
    const prompt = buildDocMetaPrompt(hints);
    expect(prompt).toContain(hints.filename);
    expect(prompt).toContain("FF-149");
    expect(prompt).toContain("2025-12-26");
    expect(prompt).toContain("R2");
  });

  it("omits filename-derived hint lines when they are absent", () => {
    const prompt = buildDocMetaPrompt({ filename: "unknown.pdf" });
    expect(prompt).not.toContain("Filename-derived reference");
    expect(prompt).not.toContain("Filename-derived date");
    expect(prompt).not.toContain("Filename-derived revision");
  });
});

describe("buildPageWindowPrompt", () => {
  it("is pure/deterministic — identical input produces identical output", () => {
    const args = { pageStart: 1, pageEnd: 6, sectionContext: ["A. SPRINKLER SYSTEM"] };
    expect(buildPageWindowPrompt(args)).toBe(buildPageWindowPrompt({ ...args, sectionContext: [...args.sectionContext] }));
  });

  it("states the absolute page range", () => {
    const prompt = buildPageWindowPrompt({ pageStart: 7, pageEnd: 12, sectionContext: [] });
    expect(prompt).toContain("pages 7-12");
    expect(prompt).toMatch(/ABSOLUTE page numbering/);
  });

  it("instructs verbatim transcription of the description", () => {
    const prompt = buildPageWindowPrompt({ pageStart: 1, pageEnd: 6, sectionContext: [] });
    expect(prompt).toMatch(/VERBATIM/);
  });

  it("explains the SITC vs SUPPLY/INSTALL vs UNKNOWN rateKind classification", () => {
    const prompt = buildPageWindowPrompt({ pageStart: 1, pageEnd: 6, sectionContext: [] });
    expect(prompt).toContain('"SITC"');
    expect(prompt).toContain('"SUPPLY"');
    expect(prompt).toContain('"INSTALL"');
    expect(prompt).toContain('"UNKNOWN"');
  });

  it("instructs never inventing a row and skipping subtotal/total/GST rollup rows", () => {
    const prompt = buildPageWindowPrompt({ pageStart: 1, pageEnd: 6, sectionContext: [] });
    expect(prompt).toMatch(/Never invent a row/);
    expect(prompt).toMatch(/subtotal row is NOT a line item|is NOT a line item/i);
  });

  it("includes prior section context for continuity when provided", () => {
    const prompt = buildPageWindowPrompt({
      pageStart: 7,
      pageEnd: 12,
      sectionContext: ["A. SPRINKLER SYSTEM", "PART II. ALARMS & ASSITANCE"],
    });
    expect(prompt).toContain("A. SPRINKLER SYSTEM");
    expect(prompt).toContain("PART II. ALARMS & ASSITANCE");
  });

  it("notes there is no prior context for the first window", () => {
    const prompt = buildPageWindowPrompt({ pageStart: 1, pageEnd: 6, sectionContext: [] });
    expect(prompt).toMatch(/no prior section context/);
  });
});
