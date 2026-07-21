/**
 * Phase C.5 WP5 (+ WP14's 5 closing scenarios) — live conversation eval for
 * the agentic chat (`src/server/chat-agent.ts#runAgentTurn`).
 *
 * Calls the REAL Anthropic (Sonnet 5 / Opus 4.8) and Gemini (extraction +
 * summary compaction) APIs against the 13 canonical conversations in
 * `eval/conversations/*.ts`. NEVER RUN IN CI — this costs real money and
 * depends on live model behaviour, which is exactly what it is testing.
 *
 * ALWAYS run it via the `eval:chat` package script, not a bare `tsx` — the
 * script wires a `node --import` resolve hook (`server-only-loader.mjs`) that
 * every `src/server/*` module this harness imports needs (`server-only` is a
 * bundler-only marker package, not an installed dependency; see
 * `server-only-stub.mjs` for the full story). Run it by hand:
 *
 *   ANTHROPIC_API_KEY=... GOOGLE_GENERATIVE_AI_API_KEY=... \
 *     pnpm --filter @pebble/web eval:chat
 *
 *   # or Vertex (postpaid, IAM):
 *   ANTHROPIC_API_KEY=... PEBBLE_AI_PROVIDER=vertex GOOGLE_VERTEX_PROJECT=<project> \
 *     GOOGLE_VERTEX_LOCATION=global GOOGLE_VERTEX_ACCESS_TOKEN=$(gcloud auth print-access-token) \
 *     pnpm --filter @pebble/web eval:chat -- --only happy-path
 *
 * Without keys it exits 2 with setup instructions (never confused with a real
 * eval failure). Each scenario runs against its OWN fresh PGlite database
 * (migrated + seeded), sequentially — PGlite is single-process, and isolation
 * keeps budget/contradiction/ledger assertions from leaking across cases.
 *
 * Flags:
 *   --only <slug>[,<slug>...]   run only the named scenario(s)
 *
 * Exit codes: 0 all requested scenarios passed; 1 at least one failed
 * (assertion failure OR a harness crash, reported per-row); 2 setup problem
 * (missing model keys — see `requireChatModelsOrExit`).
 */
import { SCENARIOS } from "../eval/conversations/index";
import { caseCostUsd, createHarnessCtx, requireChatModelsOrExit, type CaseResult } from "../eval/harness";

interface Args {
  only: string[] | null;
}

function parseArgs(argv: string[]): Args {
  const idx = argv.indexOf("--only");
  if (idx === -1) return { only: null };
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) {
    console.error("--only requires a value, e.g. --only happy-path or --only happy-path,curveball");
    process.exit(2);
  }
  return { only: value.split(",").map((s) => s.trim()).filter(Boolean) };
}

interface CaseRow {
  slug: string;
  pass: boolean;
  skipped?: boolean;
  costUsd: number;
  wallMs: number;
  notes: string[];
}

function fmtRow(row: CaseRow): string {
  const status = row.skipped ? "SKIP" : row.pass ? "PASS" : "FAIL";
  return `${row.slug.padEnd(24)} ${status.padEnd(5)} $${row.costUsd.toFixed(4).padStart(8)}  ${String(row.wallMs).padStart(7)}ms`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Resolve (and, for --only, validate) the scenario list BEFORE the model-key
  // guard, so `pnpm eval:chat` always shows what it WOULD run — including with
  // no keys set at all, where this doubles as part of the setup instructions
  // rather than being silently skipped ahead of the exit(2) below.
  let scenarios = SCENARIOS;
  if (args.only) {
    const wanted = new Set(args.only);
    scenarios = SCENARIOS.filter((s) => wanted.has(s.slug));
    const known = new Set(SCENARIOS.map((s) => s.slug));
    for (const slug of args.only) {
      if (!known.has(slug)) {
        console.error(`Unknown scenario "${slug}". Known: ${[...known].join(", ")}`);
        process.exit(2);
      }
    }
  }

  console.log(
    `chat-agent-eval: ${SCENARIOS.length} scenario(s) registered — ${SCENARIOS.map((s) => s.slug).join(", ")}`,
  );
  console.log(
    `chat-agent-eval: running ${scenarios.length} scenario(s) this invocation — ${scenarios.map((s) => s.slug).join(", ")}\n`,
  );

  const models = requireChatModelsOrExit(process.env);

  const rows: CaseRow[] = [];
  for (const scenario of scenarios) {
    console.log(`\n=== ${scenario.slug} — ${scenario.description}`);
    const handle = await createHarnessCtx(models);
    const startedAt = Date.now();
    let result: CaseResult;
    try {
      result = await scenario.run(handle.ctx);
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      result = { pass: false, notes: [`HARNESS CRASH: ${detail}`] };
    }
    const wallMs = Date.now() - startedAt;
    let costUsd = 0;
    try {
      costUsd = await caseCostUsd(handle.ctx.db, handle.ctx.user.firebaseUid);
    } catch {
      // Cost lookup failing is not itself a scenario failure — the row below
      // will still surface the underlying crash notes if any.
    }
    await handle.close().catch(() => undefined);

    const row: CaseRow = {
      slug: scenario.slug,
      pass: result.pass,
      skipped: result.skipped,
      costUsd,
      wallMs,
      notes: result.notes,
    };
    rows.push(row);
    console.log(fmtRow(row));
    for (const note of result.notes) console.log(`  - ${note}`);
  }

  console.log("\n=== Summary ===");
  console.log("slug                     status  cost         wall");
  for (const row of rows) console.log(fmtRow(row));

  // A skip always carries pass:true (see `CaseResult.skipped`'s doc comment),
  // so it never contributes to `failed` — it just gets its own SKIP label and
  // its own count in the summary line below.
  const failed = rows.filter((r) => !r.pass);
  const skipped = rows.filter((r) => r.skipped);
  const totalCost = rows.reduce((sum, r) => sum + r.costUsd, 0);
  console.log(
    `\n${rows.length - failed.length}/${rows.length} passed` +
      (skipped.length > 0 ? ` (${skipped.length} skipped)` : "") +
      ` — total cost $${totalCost.toFixed(4)}`,
  );

  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.map((r) => r.slug).join(", ")}`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
