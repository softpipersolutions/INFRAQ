import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { StubEmbedder } from "@pebble/ai";
import type { DocMeta, LanguageModel, PageLines } from "@pebble/ai";
import type { DbHandle } from "@pebble/db";
import { extractionRuns, ragChunks, sourceDocuments, stagedRecords } from "@pebble/db/schema";
import { getSourceDocument } from "@pebble/db";
import { stagedPayloadSchemaFor, type TargetMaster } from "@pebble/shared";
import { StubEmailProvider, StubWhatsAppProvider } from "@pebble/dispatch";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/app";
import { ingestSourceDocument } from "../src/ingest";
import type { IngestDeps } from "../src/ingest";
import { StubPdfRenderer } from "../src/pdf";
import { LocalStorageAdapter } from "../src/storage";
import { freshDb, stubIngestAi, tempStorageDir } from "./helpers";

/**
 * End-to-end tests for the resumable ingestion pipeline (WP3) — everything on
 * PGlite + a temp-dir LocalStorageAdapter + a scripted stub LanguageModel.
 * ZERO network: the "model" replays canned generateObject payloads (mirroring
 * packages/ai/test/ingest-extract.test.ts's stubbing approach), and the
 * embedder is the deterministic StubEmbedder.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CORPUS_XLSX = join(
  REPO_ROOT,
  "Amitabh Fire Safety BOQ Data",
  "FF-103 V Agarwal Hotel (09112024 R0).xlsx",
);

// ─── Scripted stub model ────────────────────────────────────────────────────

/** A payload to return, or a function to invoke (which may throw). */
type Responder = unknown | (() => unknown);

interface ScriptedModel {
  model: LanguageModel;
  /** Per-lane call counts, keyed by which prompt the call carried. */
  counts: { meta: number; window: number };
}

/**
 * A LanguageModelV2-shaped stub whose doGenerate replays scripted payloads.
 * Which lane a call belongs to is detected from the prompt text itself (the
 * doc-meta prompt says "entire document"; the window prompt says "pages N-M"),
 * so call-count assertions target the exact model call the pipeline made.
 * The last scripted payload repeats if a lane is called more times than
 * scripted. modelId defaults to a gemini id so estimateCostUsd prices it.
 */
function scriptedModel(
  script: { meta?: Responder[]; window?: Responder[] },
  opts: { modelId?: string; usage?: { inputTokens: number; outputTokens: number } } = {},
): ScriptedModel {
  const usage = opts.usage ?? { inputTokens: 1000, outputTokens: 200 };
  const counts = { meta: 0, window: 0 };
  const model = {
    specificationVersion: "v2",
    provider: "stub-provider",
    modelId: opts.modelId ?? "gemini-test",
    supportedUrls: {},
    doGenerate: async (options: { prompt: Array<{ role: string; content: unknown }> }) => {
      const userMessage = options.prompt.find((m) => m.role === "user");
      const parts = (userMessage?.content ?? []) as Array<{ type: string; text?: string }>;
      const text = parts.find((p) => p.type === "text")?.text ?? "";
      const lane: "meta" | "window" = /entire document/i.test(text) ? "meta" : "window";
      const queue = script[lane] ?? [];
      const idx = counts[lane];
      counts[lane] += 1;
      const responder = queue[Math.min(idx, queue.length - 1)];
      if (responder === undefined) throw new Error(`stub model: no scripted ${lane} response`);
      const payload = typeof responder === "function" ? (responder as () => unknown)() : responder;
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        finishReason: "stop",
        usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("doStream not implemented in stub");
    },
  } as unknown as LanguageModel;
  return { model, counts };
}

// ─── Canned payloads ────────────────────────────────────────────────────────

const CANNED_META: DocMeta = {
  clientName: "Shri Narayan Plaza",
  projectName: "Narayan Plaza — Active Fire Fighting",
  attention: null,
  docDateISO: "2022-09-21",
  revision: "R0",
  sourceEntityGuess: "Greenberg Enterprises",
  docKind: "proposal",
  systemsMentioned: ["FAS"],
  sections: [{ title: "A. FIRE ALARM SYSTEM", systemGuess: "FAS" }],
  grandTotalRupees: 34900,
  gstMentioned: true,
  summary: "A historical fire-safety proposal fixture: FAS detectors and cable tray.",
};

/** Line 1 strongly matches the seeded "Photoelectric Smoke Detector"; line 2 is novel. */
const CANNED_LINES: PageLines = {
  lines: [
    {
      slNo: "1",
      description: "Photoelectric Smoke Detector; Make - Agni",
      makeRaw: "Agni",
      qty: 10,
      unitRaw: "Nos",
      unitRateRupees: 1450,
      rateKind: "SITC",
      amountRupees: 14500,
      section: "A. FIRE ALARM SYSTEM",
      page: 1,
      confidence: 0.95,
    },
    {
      slNo: "2",
      description: "Aluminium Ladder Type Cable Tray 300mm wide with covers",
      makeRaw: null,
      qty: 24,
      unitRaw: "mtr",
      unitRateRupees: 850,
      rateKind: "SITC",
      amountRupees: 20400,
      section: "A. FIRE ALARM SYSTEM",
      page: 2,
      confidence: 0.9,
    },
  ],
  termsText: "Payment: 50% advance, balance on completion.",
};

// ─── Fixture builders ───────────────────────────────────────────────────────

/** A tiny real 2-page PDF built with pdf-lib. */
async function buildTestPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, line] of ["FF-01 Test Plaza — proposal page 1", "BOQ lines — page 2"].entries()) {
    const page = doc.addPage([400, 300]);
    page.drawText(`${line} (${i + 1})`, { x: 40, y: 220, size: 12, font });
  }
  return doc.save();
}

interface Fixture {
  handle: DbHandle;
  storage: LocalStorageAdapter;
  deps: (model: LanguageModel | null) => IngestDeps;
  pdfUri: string;
}

async function fixture(handle: DbHandle): Promise<Fixture> {
  const storage = new LocalStorageAdapter(await tempStorageDir());
  const put = await storage.put(
    "corpus/FF-01 Test Plaza - SITC Fire Fighting (21092022 R0).pdf",
    Buffer.from(await buildTestPdf()),
    "application/pdf",
  );
  const deps = (model: LanguageModel | null): IngestDeps => ({
    db: handle.db,
    storage,
    ai: { model, embedder: new StubEmbedder() },
  });
  return { handle, storage, deps, pdfUri: put.uri };
}

async function allStaged(handle: DbHandle) {
  return handle.db.select().from(stagedRecords);
}
async function allRuns(handle: DbHandle) {
  return handle.db.select().from(extractionRuns);
}
async function allChunks(handle: DbHandle) {
  return handle.db.select().from(ragChunks);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ingestSourceDocument (PDF, stub model)", () => {
  let handle: DbHandle;
  beforeEach(async () => {
    handle = await freshDb();
  });
  afterEach(async () => {
    await handle.close();
  });

  it("E2E: registers, extracts, stages and chunks a PDF to DONE", async () => {
    const fx = await fixture(handle);
    const { model, counts } = scriptedModel({ meta: [CANNED_META], window: [CANNED_LINES] });

    const report = await ingestSourceDocument(fx.deps(model), { sourceUri: fx.pdfUri });

    expect(report.status).toBe("DONE");
    expect(report.runId).not.toBeNull();
    expect(report.promptVersion).toBe("pdf-extract-v1");
    expect(report.pagesProcessed).toBe(2);
    expect(report.linesStaged).toBe(2);
    expect(report.chunksIndexed).toBe(3); // doc_summary + 1 boq_section + terms
    expect(report.costUsd).toBeGreaterThan(0);
    expect(counts.meta).toBe(1);
    expect(counts.window).toBe(1); // 2 pages ≤ 8 → one whole-doc window

    // The document row: registered from the filename parse, now DONE.
    const doc = await getSourceDocument(handle.db, report.sourceDocumentId);
    expect(doc?.status).toBe("DONE");
    expect(doc?.fileRef).toBe("FF-01");
    expect(doc?.revision).toBe("R0");
    expect(doc?.pageCount).toBe(2);
    expect(doc?.sourceEntity).toBe("Greenberg Enterprises");

    // Staged rows validate against the SHARED payload schemas.
    const staged = await allStaged(handle);
    expect(staged).toHaveLength(2);
    for (const rec of staged) {
      const parsed = stagedPayloadSchemaFor(rec.targetMaster as TargetMaster).safeParse(rec.proposed);
      expect(parsed.success).toBe(true);
    }
    // Line 1 → a price point on the existing seeded material (strong trgm match).
    const pricePoint = staged.find((r) => r.targetMaster === "prices");
    expect(pricePoint).toBeDefined();
    expect(pricePoint?.dedupCandidateCode).toBe("FAS-SMK-001");
    expect((pricePoint?.proposed as { materialCode: string }).materialCode).toBe("FAS-SMK-001");
    expect(pricePoint?.sourceLocator).toEqual({ page: 1 });
    // Line 2 → a new-material bundle with a proposed house code, no candidate.
    const bundle = staged.find((r) => r.targetMaster === "materials");
    expect(bundle).toBeDefined();
    expect(bundle?.dedupCandidateCode).toBeNull();
    expect(bundle?.sourceLocator).toEqual({ page: 2 });
    const bundleCode = (bundle?.proposed as { material: { materialCode: string } }).material.materialCode;
    expect(bundleCode).toMatch(/^FAS-/);

    // Chunks: the full set, embeddings from the stub embedder (768-dim).
    const chunks = await allChunks(handle);
    expect(new Set(chunks.map((c) => c.chunkKind))).toEqual(new Set(["doc_summary", "boq_section", "terms"]));
    expect(chunks.every((c) => c.embedding !== null && c.embedding.length === 768)).toBe(true);

    // Extraction run: SUCCEEDED, with the stub usage priced at the gemini rate.
    const runs = await allRuns(handle);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("SUCCEEDED");
    expect(runs[0]?.promptVersion).toBe("pdf-extract-v1");
    // meta (1000/200) + one window (1000/200) at gemini $0.15/$0.60 per M.
    expect(Number(runs[0]?.costUsd)).toBeCloseTo(0.00054, 6);
    expect(report.costUsd).toBeCloseTo(0.00054, 6);
  });

  it("resumes from META_DONE after a lines-pass crash, without re-calling extractDocMeta", async () => {
    const fx = await fixture(handle);
    const broken = scriptedModel({
      meta: [CANNED_META],
      window: [
        () => {
          throw new Error("window exploded");
        },
      ],
    });

    await expect(ingestSourceDocument(fx.deps(broken.model), { sourceUri: fx.pdfUri })).rejects.toThrow(
      /window exploded/,
    );
    expect(broken.counts.meta).toBe(1);

    // The failure landed cleanly: doc FAILED, run FAILED, meta work persisted.
    const docId = (await handle.db.select().from(sourceDocuments))[0]!.id;
    const failedDoc = await getSourceDocument(handle.db, docId);
    expect(failedDoc?.status).toBe("FAILED");
    const runsAfterFail = await allRuns(handle);
    expect(runsAfterFail).toHaveLength(1);
    expect(runsAfterFail[0]?.status).toBe("FAILED");
    const metaJson = await fx.storage.get(fx.storage.keyToUri(`ingest-work/${docId}/meta.json`));
    expect(JSON.parse(metaJson.toString("utf8")).meta.docKind).toBe("proposal");
    // The doc_summary chunk was already indexed at META_DONE.
    const chunksAfterFail = await allChunks(handle);
    expect(chunksAfterFail.map((c) => c.chunkKind)).toEqual(["doc_summary"]);

    // Re-invoke with a stub that has NO meta script — it would throw if called.
    const fixed = scriptedModel({ window: [CANNED_LINES] });
    const report = await ingestSourceDocument(fx.deps(fixed.model), { sourceDocumentId: docId });

    expect(report.status).toBe("DONE");
    expect(fixed.counts.meta).toBe(0); // resumed from META_DONE — no second meta pass
    expect(fixed.counts.window).toBe(1);
    expect(report.linesStaged).toBe(2);
    const runs = await allRuns(handle);
    expect(runs.map((r) => r.status).sort()).toEqual(["FAILED", "SUCCEEDED"]);
  });

  it("force: re-ingests a DONE document, replacing PROPOSED rows and rebuilding chunks", async () => {
    const fx = await fixture(handle);
    const first = scriptedModel({ meta: [CANNED_META], window: [CANNED_LINES] });
    const initial = await ingestSourceDocument(fx.deps(first.model), { sourceUri: fx.pdfUri });
    expect(initial.status).toBe("DONE");
    expect(await allStaged(handle)).toHaveLength(2);

    // Changed extraction: only the novel line remains, no terms.
    const changedLines: PageLines = { lines: [CANNED_LINES.lines[1]!], termsText: null };
    const second = scriptedModel({ meta: [CANNED_META], window: [changedLines] });
    const report = await ingestSourceDocument(fx.deps(second.model), {
      sourceUri: fx.pdfUri,
      force: true,
    });

    expect(report.status).toBe("DONE");
    expect(second.counts.meta).toBe(1); // force replays from REGISTERED
    expect(report.linesStaged).toBe(1);
    const staged = await allStaged(handle);
    expect(staged).toHaveLength(1); // old PROPOSED rows replaced
    expect(staged[0]?.targetMaster).toBe("materials");
    const chunks = await allChunks(handle);
    expect(new Set(chunks.map((c) => c.chunkKind))).toEqual(new Set(["doc_summary", "boq_section"]));
    expect(await allRuns(handle)).toHaveLength(2);
  });

  it("returns the DONE report with zero work when re-invoked without force", async () => {
    const fx = await fixture(handle);
    const { model } = scriptedModel({ meta: [CANNED_META], window: [CANNED_LINES] });
    const first = await ingestSourceDocument(fx.deps(model), { sourceUri: fx.pdfUri });
    expect(first.status).toBe("DONE");
    const stagedBefore = await allStaged(handle);
    const runsBefore = await allRuns(handle);

    const untouched = scriptedModel({}); // any call would throw
    const again = await ingestSourceDocument(fx.deps(untouched.model), { sourceUri: fx.pdfUri });

    expect(again.status).toBe("DONE");
    expect(again.sourceDocumentId).toBe(first.sourceDocumentId);
    expect(again.runId).toBe(first.runId);
    expect(again.linesStaged).toBe(0);
    expect(again.chunksIndexed).toBe(0);
    expect(again.costUsd).toBe(0);
    expect(untouched.counts.meta + untouched.counts.window).toBe(0);
    expect(await allStaged(handle)).toHaveLength(stagedBefore.length);
    expect(await allRuns(handle)).toHaveLength(runsBefore.length);
  });

  it("PDF with no model configured → 503 WorkerError, no extraction run created", async () => {
    const fx = await fixture(handle);
    await expect(ingestSourceDocument(fx.deps(null), { sourceUri: fx.pdfUri })).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(/extraction model not configured/),
    });
    expect(await allRuns(handle)).toHaveLength(0);
  });
});

describe("ingestSourceDocument (XLSX, no model)", () => {
  let handle: DbHandle;
  beforeEach(async () => {
    handle = await freshDb();
  });
  afterEach(async () => {
    await handle.close();
  });

  it("ingests the real FF-103 workbook deterministically to DONE with model: null", async () => {
    const storage = new LocalStorageAdapter(await tempStorageDir());
    const deps: IngestDeps = {
      db: handle.db,
      storage,
      ai: { model: null, embedder: new StubEmbedder() },
    };
    const uri = pathToFileURL(CORPUS_XLSX).href;

    const report = await ingestSourceDocument(deps, { sourceUri: uri });

    expect(report.status).toBe("DONE");
    expect(report.runId).not.toBeNull();
    expect(report.promptVersion).toBe("xlsx-deterministic-v1");
    expect(report.linesStaged).toBeGreaterThan(0);
    expect(report.chunksIndexed).toBeGreaterThan(1);
    expect(report.costUsd).toBe(0);

    const doc = await getSourceDocument(handle.db, report.sourceDocumentId);
    expect(doc?.status).toBe("DONE");
    expect(doc?.fileRef).toBe("FF-103");
    expect(doc?.docType).toBe("xlsx");

    // Every staged payload validates against its shared schema.
    const staged = await allStaged(handle);
    expect(staged.length).toBe(report.linesStaged);
    for (const rec of staged) {
      const parsed = stagedPayloadSchemaFor(rec.targetMaster as TargetMaster).safeParse(rec.proposed);
      expect(parsed.success).toBe(true);
    }
    // XLSX locators are sheet+row.
    expect(staged.every((r) => typeof (r.sourceLocator as { sheet?: string })?.sheet === "string")).toBe(true);

    // Chunks: doc_summary + boq sections (no terms in a workbook).
    const chunks = await allChunks(handle);
    expect(chunks.some((c) => c.chunkKind === "doc_summary")).toBe(true);
    expect(chunks.some((c) => c.chunkKind === "boq_section")).toBe(true);

    // One deterministic run, SUCCEEDED, zero cost.
    const runs = await allRuns(handle);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("SUCCEEDED");
    expect(runs[0]?.model).toBe("deterministic-xlsx");
    expect(Number(runs[0]?.costUsd)).toBe(0);
  });
});

describe("POST /tasks/ingest (app level)", () => {
  let handle: DbHandle;
  let deps: AppDeps;
  beforeEach(async () => {
    handle = await freshDb();
    deps = {
      db: handle.db,
      storage: new LocalStorageAdapter(await tempStorageDir()),
      pdf: new StubPdfRenderer(),
      providers: { email: new StubEmailProvider(), whatsapp: new StubWhatsAppProvider() },
      ingestAi: stubIngestAi(),
    };
  });
  afterEach(async () => {
    await handle.close();
  });

  it("rejects a body with neither sourceUri nor sourceDocumentId → 400", async () => {
    const app = createApp(deps);
    const res = await app.request("/tasks/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/sourceUri \/ sourceDocumentId/);
  });

  it("ingests an XLSX via the endpoint and returns the report", async () => {
    const app = createApp(deps);
    const res = await app.request("/tasks/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceUri: pathToFileURL(CORPUS_XLSX).href }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; linesStaged: number; sourceDocumentId: string };
    expect(body.status).toBe("DONE");
    expect(body.linesStaged).toBeGreaterThan(0);

    // The status listing endpoint reflects the ingested document.
    const statusRes = await app.request("/tasks/ingest/status");
    expect(statusRes.status).toBe(200);
    const listing = (await statusRes.json()) as {
      documents: Array<{ id: string; status: string; stagedCounts: Record<string, number> }>;
    };
    const docRow = listing.documents.find((d) => d.id === body.sourceDocumentId);
    expect(docRow?.status).toBe("DONE");
    expect(docRow?.stagedCounts.PROPOSED).toBe(body.linesStaged);
  });

  it("maps a PDF ingest with no model to HTTP 503", async () => {
    const storage = deps.storage as LocalStorageAdapter;
    const put = await storage.put("corpus/FF-02 No Model (01012023 R0).pdf", Buffer.from(await buildTestPdf()), "application/pdf");
    const app = createApp(deps);
    const res = await app.request("/tasks/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceUri: put.uri }),
    });
    expect(res.status).toBe(503);
  });
});
