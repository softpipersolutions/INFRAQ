#!/usr/bin/env -S npx tsx
/**
 * AI extraction eval harness (spec section E "AI eval harness").
 *
 * Needs GOOGLE_GENERATIVE_AI_API_KEY in the environment — this script calls
 * the REAL Gemini API and is NEVER run in CI. Run it by hand:
 *
 *   GOOGLE_GENERATIVE_AI_API_KEY=... pnpm --filter @pebble/ai eval:extraction
 *
 * It loads every eval/fixtures/*\/labels.json, resolves each labeled PDF
 * against the repo root, runs extractDocMeta + extractPageWindow, scores the
 * result against the hand labels with scoreExtraction, and prints a per-doc
 * + aggregate report. Exits 1 if aggregate precision < 0.90 or recall < 0.85
 * (a prompt-version regression gate); exits 2 for setup problems (missing
 * API key, no fixtures) so those are never confused with a real score
 * failure.
 *
 * DIVERGENCE from the production ingestion worker: the worker windows a PDF
 * into overlapping 6-page slices with pdf-lib (apps/worker owns that
 * dependency — packages/ai lanes stay pdf-lib-free, per WP1 scope). For the
 * small (<=15 page) hand-labeled fixtures this harness targets, a single
 * extractPageWindow call over the WHOLE PDF's bytes (pageStart=1,
 * pageEnd=<fixture's totalPages or the highest labeled/expected page>) is
 * simpler and adequate. This means the eval does not exercise cross-window
 * stitching (section continuity across a window boundary, dedup at window
 * overlaps) — that remains the worker's job to test separately.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModel } from "ai";
import { extractDocMeta, extractPageWindow } from "../src/ingest/extract";
import { scoreExtraction, type EvalExpectation, type ScoreResult } from "../src/ingest/eval-score";
import { createIngestModelFromEnv } from "../src/ingest/model";
import { estimateCostUsd, modelConfigFromEnv } from "../src/models";
import type { DocMeta, ExtractedLine } from "../src/ingest/schemas";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");
const PRECISION_GATE = 0.9;
const RECALL_GATE = 0.85;

interface FixtureFile extends EvalExpectation {
  sourceFile: string;
  totalPages?: number;
}

/** Walk up from `startDir` looking for the workspace root marker. Throws if not found. */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(join(dir, "pnpm-workspace.yaml"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(`Could not find repo root (pnpm-workspace.yaml) walking up from ${startDir}`);
}

function loadFixtures(): Array<{ slug: string; fixture: FixtureFile }> {
  let entries: string[];
  try {
    entries = readdirSync(FIXTURES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries
    .map((slug) => {
      const labelsPath = join(FIXTURES_DIR, slug, "labels.json");
      const raw = readFileSync(labelsPath, "utf8");
      return { slug, fixture: JSON.parse(raw) as FixtureFile };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function runFixture(
  model: LanguageModel,
  modelId: string,
  repoRoot: string,
  slug: string,
  fixture: FixtureFile,
): Promise<{ slug: string; score: ScoreResult; costUsd: number }> {
  const pdfPath = resolve(repoRoot, fixture.sourceFile);
  const pdfBytes = new Uint8Array(readFileSync(pdfPath));

  const pageEnd =
    fixture.totalPages ??
    Math.max(1, ...fixture.labeledPages, ...fixture.expectedLines.map((l) => l.page));

  const metaResult = await extractDocMeta({
    model,
    pdfBytes,
    hints: { filename: pdfPath.split("/").pop() ?? fixture.sourceFile },
  });
  const linesResult = await extractPageWindow({
    model,
    windowPdfBytes: pdfBytes,
    pageStart: 1,
    pageEnd,
    sectionContext: [],
  });

  const meta: DocMeta = metaResult.meta;
  const lines: ExtractedLine[] = linesResult.lines;
  const score = scoreExtraction(fixture, { meta, lines });

  const totalInputTokens = metaResult.usage.inputTokens + linesResult.usage.inputTokens;
  const totalOutputTokens = metaResult.usage.outputTokens + linesResult.usage.outputTokens;
  const costUsd = estimateCostUsd(modelId, totalInputTokens, totalOutputTokens);

  return { slug, score, costUsd };
}

async function main(): Promise<void> {
  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    console.error(`No fixtures found under ${FIXTURES_DIR} — nothing to evaluate.`);
    process.exit(2);
    return;
  }
  console.log(`Loaded ${fixtures.length} fixture(s): ${fixtures.map((f) => f.slug).join(", ")}`);

  // Model via the same env seam production uses: Vertex AI when
  // PEBBLE_AI_PROVIDER=vertex / GOOGLE_VERTEX_PROJECT is set (locally pass a
  // short-lived GOOGLE_VERTEX_ACCESS_TOKEN from `gcloud auth
  // print-access-token`), else the Developer API key.
  const model = createIngestModelFromEnv(process.env);
  if (!model) {
    console.error(
      "\nNo extraction model configured. This harness calls the real Gemini API and " +
        "cannot run without one (and is never run in CI). Either:\n" +
        "  GOOGLE_GENERATIVE_AI_API_KEY=... pnpm --filter @pebble/ai eval:extraction\n" +
        "or (Vertex):\n" +
        "  PEBBLE_AI_PROVIDER=vertex GOOGLE_VERTEX_PROJECT=<project> \\\n" +
        "  GOOGLE_VERTEX_ACCESS_TOKEN=$(gcloud auth print-access-token) \\\n" +
        "  pnpm --filter @pebble/ai eval:extraction",
    );
    process.exit(2);
    return;
  }

  const repoRoot = findRepoRoot(HERE);
  const models = modelConfigFromEnv(process.env);

  const results: Array<{ slug: string; score: ScoreResult; costUsd: number }> = [];
  for (const { slug, fixture } of fixtures) {
    console.log(`\nRunning ${slug}...`);
    const result = await runFixture(model, models.gemini, repoRoot, slug, fixture);
    results.push(result);

    console.log(
      `  precision=${fmtPct(result.score.precision)} recall=${fmtPct(result.score.recall)} ` +
        `matched=${result.score.matched}/${result.score.expectedCount} ` +
        `field(make/unit/rateKind)=${fmtPct(result.score.fieldAccuracy.make)}/` +
        `${fmtPct(result.score.fieldAccuracy.unit)}/${fmtPct(result.score.fieldAccuracy.rateKind)} ` +
        `cost=$${result.costUsd.toFixed(6)}`,
    );
    const metaMismatches = Object.entries(result.score.metaAccuracy).filter(([, ok]) => !ok);
    if (metaMismatches.length > 0) {
      console.log(`  meta mismatches: ${metaMismatches.map(([k]) => k).join(", ")}`);
    }
    for (const m of result.score.mismatches) {
      console.log(`  - ${m}`);
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      matched: acc.matched + r.score.matched,
      expectedCount: acc.expectedCount + r.score.expectedCount,
      costUsd: acc.costUsd + r.costUsd,
    }),
    { matched: 0, expectedCount: 0, costUsd: 0 },
  );
  // Precision is only honest where the labeler enumerated EVERY line on the
  // labeled pages (fullyLabeled) — partially labeled fixtures systematically
  // count correct extractions as "extra". Recall is meaningful everywhere.
  const fullSlugs = new Set(
    fixtures.filter((f) => f.fixture.fullyLabeled === true).map((f) => f.slug),
  );
  const fullTotals = results
    .filter((r) => fullSlugs.has(r.slug))
    .reduce(
      (acc, r) => ({
        matched: acc.matched + r.score.matched,
        extractedOnLabeledPages: acc.extractedOnLabeledPages + r.score.extractedOnLabeledPages,
      }),
      { matched: 0, extractedOnLabeledPages: 0 },
    );
  const aggregatePrecision =
    fullTotals.extractedOnLabeledPages === 0 ? 0 : fullTotals.matched / fullTotals.extractedOnLabeledPages;
  const aggregateRecall = totals.expectedCount === 0 ? 1 : totals.matched / totals.expectedCount;

  console.log("\n=== Aggregate ===");
  console.log(
    `precision=${fmtPct(aggregatePrecision)} over ${fullSlugs.size} fully-labeled fixture(s) (gate >= ${fmtPct(PRECISION_GATE)})`,
  );
  console.log(`recall=${fmtPct(aggregateRecall)} over all fixtures (gate >= ${fmtPct(RECALL_GATE)})`);
  console.log(`total estimated cost=$${totals.costUsd.toFixed(6)}`);

  if (fullSlugs.size === 0) {
    console.error("\nFAIL: no fully-labeled fixture — the precision gate has no honest signal.");
    process.exit(1);
  }
  if (aggregatePrecision < PRECISION_GATE || aggregateRecall < RECALL_GATE) {
    console.error("\nFAIL: aggregate precision/recall below gate.");
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
