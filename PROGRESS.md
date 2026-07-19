# Pebble Module 02 — Build Progress & Continuation Guide

> **Purpose of this file:** hand off the build to a fresh Claude Code session (local or remote) with zero context loss. Read this top-to-bottom, then follow "How to continue" at the end. The full approved architecture/build plan is in **`docs/PLAN.md`** — read that too before writing code.

Last updated: 2026-07-18 · Branch: `claude/fire-safety-boq-webapp-f5n921`

> ## 🚀 PHASE A DEPLOYED TO PRODUCTION (2026-07-19)
> Live on Cloud Run (project **infraq-greenberg**, asia-south1):
> **web** https://pebble-web-4xnkcvcksa-el.a.run.app (public, AUTH_MODE=firebase,
> Google sign-in, allowlist `PEBBLE_ALLOWED_EMAILS` repo var) · **worker**
> pebble-worker (private, OIDC-invoked, Chromium PDF, GCS outputs).
> Real letterhead (GSTIN 09AAMCG0423A1Z3, brand marks, FF-149 T&C) ships in
> `packages/documents`. RBAC live (admin/estimator/approver). Cloud SQL
> `pebble-pg` (PG16, backups+PITR) migrated + seeded; DATABASE_URL/RESEND keys
> in Secret Manager; WIF deploys from GitHub Actions on push to main
> (`DEPLOY_ENABLED` repo var). Uptime check on /login + 5xx alert policy.
> Deploy lessons burned into the tree: pnpm action version conflict, pnpm 10
> `deploy --legacy`, gcloud env-var quoting (`^|^`), lazy PGlite (prod is pg
> only), no Next standalone (custom externals defeat tracing), PORT honored in
> the start script. Next phases: B ingestion+RAG, C chat, D UAT/goldens
> (see the roadmap plan; ~/.claude/plans/now-plan-me-what-graceful-tide.md).
>
> ## ✅ BUILD COMPLETE (2026-07-18)
> All layers in §7 are built, tested, and pushed. **279 tests pass** (`pnpm -r test`);
> `pnpm -r typecheck` and `pnpm --filter @pebble/web build` are green.
> The §6 acceptance gate is verified end-to-end on the running app: an enquiry for
> *Commercial · 4 floors · 450 sqm · FAS + Extinguisher · tier 2* generates
> `GBE-EST-2026-001` — **LOCKED v1, SITC PASS (blended 1.43), margin OK, 13 lines,
> zero warnings**, grand total ₹7,65,320.27 — and the review-fork → approve cycle
> plus the full append-only audit sequence were confirmed via tRPC.
> Per-package: shared 35 · expr 123 · db 18 · engines 31 · dispatch 24 · ai 26 ·
> documents 12 · worker 10. Remaining work is future-phase (ingestion/RAG, chat UI,
> Firebase wiring, live Chromium PDF + GCS, real letterhead/GSTIN values).
> The section-2 state tables below describe the *starting* point of this build and
> are kept for history.

## 1. What this project is

**Pebble v1.0, Module 02 "Estimate Crafting Space"** — a fire-safety BOQ/estimate web app for Greenberg Enterprises (Lucknow), built by Softpiper Solutions.

Pipeline: **enquiry (A.08) → deterministic auto-draft (engines B.01–B.03) → human review with versioning → Format A BOQ (PDF/Excel) → dispatch (email/WhatsApp) → immutable 14-event audit trail**.

Non-negotiable invariants (from the client spec, `pebble-v1-module-02-estimate-crafting-space.html` in repo root):
- **SITC = Supply × 1.43**, acceptance band **1.35–1.51**; outside band → ALERT, blocks silent approval.
- **LLMs never compute prices** — all money math in pure TypeScript (`packages/engines`), integer-paise arithmetic (`packages/shared/src/money.ts`).
- **Audit is append-only** (Postgres triggers), estimate versions are copy-on-write with stable `line_uid` for diffing, rates are versioned with non-overlapping validity.
- AI split: **Gemini Flash** = retrieval/extraction lane; **Claude Sonnet default, Opus 4.8 escalation** = interpretation/drafting lane; router in `packages/ai`.
- Deploy target: **GCP** (Cloud Run web+worker, Cloud SQL Postgres 16 + pgvector, GCS, Firebase Auth). Local dev: **PGlite, zero cloud creds**.

User-confirmed decisions (do not re-litigate): full web app (forms + chat, Format B deferred), GCP + Firebase Auth, smart model routing, full ingestion+RAG of the 145 historical PDFs in `Amitabh Fire Safety BOQ Data/` (later phase).

## 2. Current state — what exists and its quality

### ✅ Complete & verified (committed, typechecks green)
| Piece | Where | Notes |
|---|---|---|
| Monorepo scaffold | root | pnpm workspaces + turbo; deps installed & lockfile committed (Next 15.5.20, tRPC 11.18, drizzle 0.44.7, AI SDK 5.0.215, PGlite 0.3.16, exceljs 4.4, hono 4.12, playwright-core 1.61) |
| `@pebble/shared` | `packages/shared` | **The frozen contract.** All enums (A.01–A.08), SITC/GST constants, integer-paise money utils + `formatINR` (Indian grouping), unit canonicalization table, zod schemas for masters/enquiry/engine-I/O, expr contract (`expr-contract.ts`). Everything else codes against this — do not change it casually. |
| `@pebble/mcp` | `packages/mcp` | Module 02 MCP server with injected `PebbleMcpServices` (dependency-light). Typechecks. |
| README, docs/PLAN.md | root, docs | PLAN.md = the full approved architecture & phase plan. |

### 🟡 Partial (typechecks green, but incomplete — built by agents that were interrupted)
| Piece | Exists | Missing |
|---|---|---|
| `@pebble/expr` (safe expression engine) | `src/`: grammar.ts (jsep config), resolve.ts, evaluate.ts, validate.ts, errors.ts, index.ts | **All tests** (`test/expr.test.ts`, `test/adversarial.test.ts`). Verify the public API matches `docs/PLAN.md` §"expr" and shared/expr-contract.ts: `ExprError, validateExpression, parseExpression, evaluateAst, evaluateCondition, evaluateQuantity`. Adversarial suite is mandatory (member access, `__proto__`, node bombs → rejected). |
| `@pebble/db` | `src/schema/*` (all ~20 tables incl. estimates/audit/ingestion/chat/llm_calls), `src/client.ts` (pg + PGlite dual driver), `src/ids.ts` | `drizzle.config.ts` + **generated migration** (run `npx drizzle-kit generate`, then hand-edit the SQL: prepend CREATE EXTENSION vector/pg_trgm/btree_gist; append audit append-only triggers, LOCKED-version immutability triggers, price/install-rate EXCLUDE-gist non-overlap constraints, rag_chunks tsvector + hnsw index), `src/migrate.ts`, **all repos** (masters/sequences/enquiries/estimates/audit/users), **seed** (~30 materials, makes, prices, install rates, ~25 design rules, margin matrix — exact seed data spec with INR rates is in section 5 below), **all tests** (PGlite `memory://`, `fileParallelism:false`). |

### 🔴 Not started
- `@pebble/engines` — B.01 generateBom / B.02 priceBom / B.03 validateSitc + computeMargin + computeTotals + generateEstimate. Exact API + semantics: `docs/PLAN.md` and section 4 below.
- `@pebble/documents` — Format A HTML (→PDF) + exceljs workbook builders.
- `@pebble/dispatch` — Resend email + AiSensy/Gupshup WhatsApp adapters + stub providers.
- `@pebble/ai` — router (intents→lanes), Opus escalation, slot-filling, extraction, master-data digest w/ prompt caching, tool defs.
- `apps/worker` — Hono service: HTML→PDF via playwright-core (Chromium), storage adapter (local/GCS), render + dispatch task endpoints.
- `apps/web` — the entire Next.js app (tRPC, dev-mode auth, dashboard, enquiry form → generate → draft grid, masters admin CRUD, audit timeline, version compare, preview route).
- `infra/` + `.github/workflows` + `.env.example`.

### Why the previous run stopped
An orchestrated 8-agent build workflow was running (2-concurrent cap on a 4-core container); the two heaviest lanes errored/were interrupted mid-run (session interruption, not a code problem — everything on disk typechecks). The remaining six work items never started.

## 3. Architecture contracts the next session MUST honor

- **Package dependency rule:** `engines/` and `expr/` are pure (no imports from db/ai). AI calls engines as tools. Web/worker orchestrate.
- **Module resolution:** TS `moduleResolution: "Bundler"`, **extensionless** relative imports, ESM everywhere, packages export TS source directly (`"exports": {".": "./src/index.ts"}`); Next.js uses `transpilePackages`.
- **Money:** engines compute in integer paise; single rounding point = line level (`lineAmount(qty, ratePaise)` from shared); DB stores NUMERIC(14,2) rupees via `paiseToNumericString`.
- **Versioning:** generation writes **v1 and locks it immediately**; first edit forks a WORKING v2 copying lines with `line_uid` preserved; approval locks; version compare = join on `line_uid`.
- **Audit events written in the same DB transaction** as the state change. 14 event types in `AUDIT_EVENT_TYPES` (shared).
- **Auth:** `AUTH_MODE=dev` (default) returns a dev admin user — the app must run with zero cloud credentials on PGlite. Firebase is a lazy optional import.
- **Models:** `claude-sonnet-4-6` default, `claude-opus-4-8` escalation, `gemini-3.5-flash` retrieval (env-overridable: `PEBBLE_CLAUDE_DEFAULT_MODEL`, `PEBBLE_CLAUDE_OPUS_MODEL`, `PEBBLE_GEMINI_MODEL`).

## 4. Engines semantics (B.01–B.03) — condensed spec

- Context per (enquiry, system): `total_area_sqm = max(floors_above,1) × floor_area_sqm`; identifiers per `EXPR_IDENTIFIERS`.
- `generateBom`: active rules per requested system → `evaluateCondition` → `evaluateQuantity`; record `AppliedRule` per fired rule; warnings: `RULE_EVAL_ERROR`, `MATERIAL_INACTIVE`, `NO_RULES_MATCHED`. One BOM line per fired rule.
- `priceBom`: make selection = Approved makes of preferred tier (make_preference; "As per Greenberg"→Standard), fallback Standard→Premium→Economy with `MAKE_UNAVAILABLE` warning, Conditional only when no Approved; price = latest effective (materialCode, makeCode) row else `PRICE_MISSING`; install rate = material-linked first, else system-generic with unit-compatible mapping (`Per No.`↔`No.` etc.) else `INSTALL_RATE_MISSING`; `supplyAmount = lineAmount(qty, sellRate)`, `installAmount = lineAmount(qty, installRate)`, `lineAmount = supplyAmount + installAmount` (additivity is the tested invariant), `sitcRate = supplyRate + installRate`.
- `validateSitc`: ratio = totalSitc/totalSupply (null if supply 0) → PASS iff within [1.35, 1.51].
- `computeMargin`: on supply only — sell = Σ supplyAmount, buy = Σ lineAmount(qty, buyingRate); below `floor_margin_pct` → BELOW_FLOOR + `required_authority` from margin matrix row.
- `computeTotals`: gst = 18% of totalSitc (applyPct), grandTotal = sitc + gst.
- `generateEstimate` composes all; `snapshot` pins ruleIds/priceIds/installRateCodes/marginTier/engineVersion; `opts.uid` injectable for deterministic golden tests.
- Tests: golden-file (deterministic uid counter, hand-verified arithmetic), fast-check properties (band iff, exact sums, order-invariance, additivity), pricing matrix table tests.

## 5. Seed data spec (for `packages/db/src/seed/`)

Margin matrix: T1 'Sub ₹5L' 25/18 Self · T2 '₹5L–20L' 22/15 GM · T3 '₹20L–1Cr' 20/12 GM · T4 '>₹1Cr' 18/10 MD.
~30 materials across FAS/Extinguisher/Hydrant/Sprinkler with codes like `FAS-SMK-001`, IS-code specs (IS 2189 detectors, IS 1239 pipes, IS 15683 extinguishers, IS 15105 sprinklers). Makes from the real corpus: Agni Devices (Economy/Standard FAS), Honeywell/Siemens (Premium FAS), Jindal (pipes), Kartar/Zoloto (valves), Kirloskar/Lubi (pumps), Tyco/Omaxe (sprinklers), Safepro/Elitech (extinguishers). Prices in realistic INR (e.g. smoke det Agni 1450/1050 sell/buy, Honeywell 2650/2050; MS pipe 100mm 1450/1120 per m; main pump 285000/230000). Install rates tuned to ≈38–46% of selling rate so demo generations land inside the SITC band. ~25 design rules with spec syntax (e.g. `DL-FAS-001`: cond `system = FAS`, qty `CEIL(total_area_sqm / 60)`, ref 'IS 2189 spacing'; pumps gated on `floors_above >= 4`, ref 'NBC 2016 Part 4'). **Every seeded material must have a price for every seeded make and a resolvable install rate → zero generation warnings in the demo.** Full details: `docs/PLAN.md` + the seed section of the original agent spec preserved in the workflow script (see §7).

## 6. How to verify at each step

```bash
pnpm install                          # deps (lockfile committed)
pnpm -r typecheck                     # every package
pnpm -r test                          # vitest suites (PGlite-backed for db)
pnpm --filter @pebble/web build       # prod build
# Smoke test (once web exists):
PGLITE_DIR=.data/smoke SEED_ON_BOOT=1 pnpm --filter @pebble/web dev
# → create enquiry (Commercial, 4 floors, 450 sqm, FAS+Extinguisher, tier 2)
# → expect a locked v1 draft, SITC badge PASS, zero warnings
```

## 7. How to continue in a NEW session

1. Read this file, then `docs/PLAN.md`, then skim `packages/shared/src/` (the contract) and the two partial packages.
2. Build order (respects dependencies): **finish `expr` tests → finish `db` (migrations+repos+seed+tests) → `engines` → `documents` + `dispatch` (parallel-safe) → `ai` → `apps/worker` + `infra` → `apps/web` core → `apps/web` admin → integration (typecheck/test/build/smoke) → commit & push per layer.**
3. The original orchestration prompts (full per-package specs incl. every table column and seed row) are preserved verbatim inside the workflow script from the previous session — if unavailable locally, `docs/PLAN.md` §4 + this file are sufficient.
4. Commit and push after each completed layer; never leave the branch broken.

### Copy-paste continuation prompt

> Continue building Pebble v1.0 Module 02 (fire-safety BOQ estimation web app) in this repo. First read `PROGRESS.md` and `docs/PLAN.md` at the repo root — they contain the full approved architecture, current build state, and remaining work. The `packages/shared` contract layer is frozen and complete; `packages/expr` needs its test suites; `packages/db` needs drizzle migration generation (+ hand-edited SQL for extensions/triggers/exclusion constraints), repositories, seed data, and tests as specified in PROGRESS.md §2/§5; then build `engines`, `documents`, `dispatch`, `ai`, `apps/worker`, `infra`, and the `apps/web` Next.js app per PROGRESS.md §7 build order and `docs/PLAN.md`. Honor the invariants in PROGRESS.md §3 (deterministic paise math, append-only audit, copy-on-write versions, SITC 1.43 band, extensionless bundler-style imports, PGlite dev mode with zero cloud creds). Verify with `pnpm -r typecheck && pnpm -r test`, the web smoke test in §6, then commit and push each completed layer to the working branch.
