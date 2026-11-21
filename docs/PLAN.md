# Pebble v1.0 — Module 02 "Estimate Crafting Space": Full Web App Build Plan

## 1. Context

Greenberg Enterprises (fire-safety contractor, Lucknow) engaged Softpiper Solutions to build **Pebble v1.0**, a modular business platform. This build delivers **Module 02 — Estimate Crafting Space**: a web app that turns a building enquiry into a professional, auditable fire-safety estimate/BOQ.

Why: today estimates are hand-crafted (145 historical proposals in `proposal-corpus/` prove it — makes buried in free text, no rate history, no audit trail). The app automates **enquiry → auto-draft → human review → Greenberg-format quote → dispatch**, with deterministic pricing (LLMs never touch a rupee figure) and an immutable 14-event audit trail. Core business rule: **SITC = Supply × 1.43** (alert band 1.35–1.51).

**Source documents** (read in full): Module 02 technical spec (`pebble-v1-module-02-estimate-crafting-space.html`, in repo root — masters A.01–A.08, engines B.01–B.03, Format A/B, audit events) and the MVP Build Proposal (uploaded HTML — two-lane AI orchestration, stack, economics).

## 2. User-confirmed decisions (2026-07-17)

1. **Scope**: Full web app — chat interface AND structured screens (enquiry form, estimate review/edit grid, master-data admin panels, dashboard, audit timeline, version compare). Format B (client-template mapping) deferred.
2. **Deployment**: GCP — Cloud Run + Cloud SQL Postgres + Cloud Storage + Firebase Auth (Google sign-in), under the Google for Startups grant.
3. **AI**: Smart routing — Gemini Flash (retrieval lane); Claude Sonnet default, auto-escalation to Opus 4.8 (generation lane). All math in deterministic TypeScript.
4. **Seed data**: Full ingestion pipeline mining the 145 historical proposals to pre-seed masters (human verification queue before commit) + RAG index ("what did we quote before?").

## 3. What the historical corpus taught us (grounds the design)

**Excel analysis** (3 workbooks): two reusable schemas — (a) DSR-style estimates keyed to CPWD DSR-2022 E&M codes with SOR/DSR/MR rate columns, per-floor quantity takeoff sheets, and rate-analysis build-up chains (base → −15% discount → +2% packing → +5–10% fitting → +15% OH&P → rounded rate); (b) commercial BOMs with combined SITC unit price, make embedded in description text ("Make - Jindal (ISI)", "Kirloskar OR Lubi"), GST 18%, PART/section grouping.

**PDF analysis** (8 proposals sampled, 2022–2026): template highly consistent — letterhead (GSTIN, Example Bank payment block 2024+) → Attn/Date/Rev → project block → PART I/II lettered sections → line items (Sl.No | Description | Indicative Images | Unit | Qty | **Unit Price (SITC)** | Amount | Remarks) → section subtotals → GST rollup → 10-point T&C → signatory (NEBOSH/NFPA credentials). This IS Format A; the PDF generator reproduces it. Some jobs issue parallel "Supply Only" + "Labour Charges" PDFs → support both combined-SITC and split output modes. Validity 7 days; payment plans vary by project size; makes observed seed A.03 (Jindal, Kartar, Zoloto, Kirloskar, Lubi, Tyco, Agni Devices, Edwards/Honeywell/Simplex/Siemens/Notifier, Elitech…).

**Key implications**: (1) design-basis in old docs is implicit (ISI/UL/FM marks, no IS-code tables) — the A.06 rule library is NEW value and must be seeded/validated with Greenberg's engineer, not extracted; (2) units are inconsistent (mtr/Mtr, pcs/Each/No.) → normalization table required; (3) 2023 docs are under predecessor entity "Sample Traders" → ingestion tags source entity; letterhead is editable config.

## 4. Architecture

### 4.1 Monorepo (pnpm + Turborepo) — one Next.js app + one worker, no NestJS

A separate NestJS API doubles the maintained surface for a 1–3 dev team. Next.js App Router (tRPC v11 for typed app APIs; plain route handlers only for webhooks + streaming chat) covers the API. Heavy/long work (Chromium PDF render, 145-doc ingestion, dispatch retries) goes to a small **Hono worker** on Cloud Run invoked via Cloud Tasks.

```
pebble/
├── apps/
│   ├── web/          # Next.js 15: all UI + tRPC + webhooks + chat streaming
│   └── worker/       # Hono: Cloud Tasks handlers — ingestion, PDF/Excel render, dispatch
├── packages/
│   ├── shared/       # zod schemas (type source of truth), enums, unit normalizer, money utils
│   ├── db/           # Drizzle schema, migrations, repositories, seeds
│   ├── expr/         # safe expression engine (jsep + whitelisting interpreter)
│   ├── engines/      # B.01 design logic, B.02 pricing, B.03 SITC, margin gate — PURE, zero I/O
│   ├── ai/           # router, lanes, prompts, tools, RAG (Vercel AI SDK)
│   ├── documents/    # Format A HTML template, exceljs builder, letterhead assets
│   ├── dispatch/     # email + WhatsApp adapters (Resend, AiSensy, Gupshup, Stub)
│   └── mcp/          # MCP server exposing Module 02 tools (Pebble module boundary)
├── infra/            # Dockerfiles, deploy scripts, GitHub Actions
```

**Enforced rule**: `engines/` and `expr/` import nothing from `db/` or `ai/`. LLMs never compute numbers; engines never call LLMs. AI calls engines as tools.

**GCP topology**: Cloud Run `web` + Cloud Run `worker` (image includes Chromium), Cloud SQL Postgres 16 (+ `pgvector`, `pg_trgm`, `btree_gist`), GCS buckets `raw-docs` + `generated-outputs`, Cloud Tasks queues (`ingest`, `generate-output`, `dispatch`), Firebase Auth (roles admin/estimator/approver as custom claims), Secret Manager. CI/CD: GitHub Actions → deploy on main; migrations as pre-deploy job.

**Money**: `NUMERIC(14,2)` in Postgres; engines compute in integer paise, round half-up at line level, sum exact — golden tests are exact, no float drift in SITC ratios.

### 4.2 Database (Drizzle ORM — SQL-first fits pgvector/tstzrange/exclusion constraints/triggers; lighter cold starts than Prisma)

**Masters (A.01–A.07)**: `materials` (material_code PK, system_type, category, unit, active, source_provenance JSONB), `material_specs` (1:1), `makes` (tier, approval_status), `prices` (ULID PK, buying/selling rate, **validity tstzrange + EXCLUDE gist constraint — no overlapping rates ever; append-only**), `install_rates` (same pattern), `design_rules` (rule_code + rule_version, condition_expr + validated condition_ast JSONB, quantity_formula + ast, standard_reference; edits insert version+1), `margin_matrix` (tier 1–4, target/floor margin, discount_authority).

**Estimates**: `enquiries` (GBE-ENQ-YYYY-NNN via yearly sequence; source form|chat), `estimates` (status, sitc_status PASS/ALERT, margin_status, required_authority), `estimate_versions` (version_no, state LOCKED|WORKING, **generation_snapshot JSONB pinning rule versions + price_ids + engine semver**, totals, blended_ratio), `estimate_lines` (**line_uid UUID stable across versions → powers diff**; denormalized description/brand/rate snapshots so approved estimates render identically forever; source RULE|MANUAL, rule_code, price_id, edit_reason).

**Versioning = copy-on-write**: generation writes v1 and locks it immediately. First edit forks → v2 WORKING (line_uids preserved). Approval locks; post-approval changes require EST_REVISED → new version. **Version compare** = join lines on line_uid (A-only=removed, B-only=added, both=field deltas) — pure function, no diff storage.

**Audit**: `audit_events` (ULID PK = chronological, 14 event types, actor, payload JSONB) — **Postgres trigger raises on UPDATE/DELETE; app role has INSERT/SELECT only**; events written in the same transaction as the state change they describe.

**Supporting**: `generated_documents` (gcs_uri, sha256), `dispatches` (outbox pattern, provider status), `source_documents` / `extraction_runs` / `staged_records` (ingestion verification queue with page/cell locators + dedup candidates), `rag_chunks` (vector(768) + tsvector, HNSW index), `users`, `chat_sessions`/`chat_messages` (slot-filling state JSONB).

### 4.3 Safe expression engine (packages/expr)

**jsep parser + hand-written ~250-line whitelisting interpreter** (expr-eval unmaintained; CEL-js immature). Custom operators `AND OR NOT = <>` so staff write exactly the spec syntax (`building_type = Commercial AND floor_area <= 500`). Whitelist node types only (Binary/Unary/Literal/Identifier/Call-from-function-table/Conditional); any MemberExpression → hard error. Function table: CEIL, FLOOR, ROUND, MIN, MAX, IF, CLAMP. Typed context: building_type, floors_above, floor_area_sqm, total_area_sqm, system, make_preference, applicable_standard, project_tier — unknown identifier errors, never undefined. Save-time validation in the A.06 admin panel: parse → type-check (condition:boolean, formula:numeric) → live dry-run against 3 sample enquiries. Runtime: node cap, finite ≥ 0 results; rule failures become generation warnings + audit payloads, not crashes.

### 4.4 AI orchestration (packages/ai, Vercel AI SDK)

**Router** (deterministic-first): slot-filling in progress → stay in lane; UI button actions → direct route; else one cheap Gemini Flash enum-constrained classification: LOOKUP/EXTRACT/RECALL → Gemini lane; INTERPRET/DRAFT_ASSIST/EXPLAIN → Claude lane; COMPUTE-class → engines directly (never a model). **Opus 4.8 escalation on explicit triggers**: low router confidence, slots contradictory after 2 clarification turns, user challenges a draft decision, long review conversations. Every call logs {lane, model, tokens, cost} to `llm_calls` for the cost dashboard.

**Chat slot-filling**: zod A.08 schema with per-field missing|proposed|confirmed in `chat_sessions.slot_state`. Gemini extracts newly-mentioned fields per message; **code** computes remaining slots and injects "ask next for X". All slots proposed → structured confirmation card → user confirms → `create_enquiry` tool (validates via the same tRPC service the form uses) → ENQ_CREATED → deterministic generation → draft grid opens.

**Tools** (thin service wrappers): lookup_material, list_makes_for_material, get_current_price, search_past_estimates, get_design_rules, update_enquiry_draft, create_enquiry, get_estimate_version, explain_line (feeds rule_code + RULE_APPLIED/PRICE_APPLIED audit payloads + standard_reference so Claude explains from facts), propose_line_edit (suggestion only — applied on human click; the model cannot mutate estimates).

**RAG**: pgvector on Cloud SQL (145 docs ≈ few thousand chunks; one DB, plain SQL metadata filters, zero extra grant spend — Vertex AI Search rejected at this size). Gemini embeddings (768-dim). Chunks: doc_summary per proposal + per BOQ section + terms, metadata JSONB (client, systems, date, total). Hybrid retrieval: vector + tsvector + metadata filter, reciprocal rank fusion in SQL. Answers cite source filenames with links to the original PDF in GCS.

**Prompt caching (Claude lane)**: system prompt ordered [persona/rules] → [master-data digest with cache_control] → [conversation]; digest regenerated only when a content-hash over masters changes → cache hits persist across all chats.

### 4.5 Ingestion pipeline (apps/worker, Cloud Tasks, resumable per doc)

**PDFs: Gemini Flash multimodal directly on pages** with zod-structured outputs (140+ heterogeneous layouts, some scanned — regex/text-extraction doesn't amortize; kept only as a confidence cross-check). **XLSX: deterministic exceljs parsing** (3 known structures) + LLM assist only for makes in free text.

Steps: (1) register files in GCS, parse filename convention (`FF-105 … (08122024 R1)`) → source_documents; (2) whole-doc metadata pass → doc_summary RAG chunk immediately; (3) page-windowed line extraction → {description, make_raw, qty, unit_raw, rates, section} + confidence + page locator; DSR docs also capture rate-analysis build-up chains; (4) pure-code normalization: unit canonicalization map (tested over every observed variant), brand canonicalization, qty×rate≈amount cross-check adjusts confidence; (5) dedup via pg_trgm + embedding similarity → propose merge-into-existing (alias recorded) or new material with spec-convention code (FAS-SMK-001); prices staged with historic effective_from; (6) **verification queue UI**: two-pane (rendered source page auto-scrolled to locator ⟷ editable proposed record with confidence badge + dedup suggestion), keyboard-driven, bulk-approve above threshold — **nothing enters masters without passing this queue**; every commit stamps source_provenance; (7) RAG indexing happens at step 2–3 regardless of master approval — historical Q&A works from week one.

### 4.6 Documents (packages/documents, rendered in worker)

**PDF: HTML/CSS template + Playwright headless Chromium** — one template serves on-screen preview, print CSS, and pixel-faithful letterhead with repeating headers/footers + page numbers (react-pdf/pdfkit rejected: dense 9-column BOQ tables + fast letterhead iteration is exactly what CSS does well). **Excel: exceljs** — Summary sheet, per-system sections, merged title rows, ₹ formats, live subtotal formulas, GST breakout, terms sheet. Rendered only from **locked** versions; uploaded to GCS with sha256 → generated_documents → OUTPUT_GENERATED audit. Filenames: `GBE-EST-2025-014 R2 - <Project> - BOQ.pdf`. Signed URLs (7-day).

### 4.7 Dispatch (packages/dispatch)

**Email: Resend** (clean API, attachments, React Email cover notes). **WhatsApp: pluggable `WhatsAppProvider` interface** — AiSensy/Gupshup/**Stub** implementations selected by env var; stub ships first so dispatch demos before any vendor contract. All dispatch is outbox-pattern: QUEUED row + audit intent → Cloud Tasks → worker sends with retry → provider webhooks update status. One dispatch action fans out email + WhatsApp with the same GCS artifacts.

## 5. Build phases (2 devs; ranges widen at 1)

| Phase | Weeks | Scope | Demoable outcome |
|---|---|---|---|
| **0 Foundation** | 1 | Monorepo, CI/CD to Cloud Run, Cloud SQL + migrations, Firebase Auth + roles, app shell | Google sign-in on a deployed URL |
| **1 Masters + Engines** | 2–4 | A.01–A.07 admin CRUD; expr engine; design/pricing/SITC/margin engines + golden tests; hand-seed ~30 FAS materials/rules with Greenberg; enquiry form; generate | **Form → priced auto-draft v1 grid with SITC PASS/ALERT** (core value, week 4) |
| **2 Review + Audit** | 5–7 | Review/edit grid, version fork-on-edit, approval gates (SITC band, margin floor → authority), audit timeline, version compare | Full draft → edit → approve cycle with immutable trail + v1↔v2 diff |
| **3 Output + Dispatch** | 8–9 | Format A PDF + Excel, worker live, Resend email + WhatsApp stub, dashboard v1 | **End-to-end: enquiry → approved → branded PDF/Excel emailed. Production-usable** |
| **4 Ingestion + RAG** | 10–12 | Extraction over all 145 docs, verification queue UI, masters at scale (all 5 systems), pgvector RAG + history Q&A | Masters seeded with provenance; "what did we quote for X?" |
| **5 Chat + MCP** | 13–15 | Chat UI, router, two lanes, slot-filling, explain/review with Opus escalation, prompt caching, MCP server | **Chat a raw enquiry → confirmed record → draft grid**; rule-cited "why 14 detectors?" answers |
| **6 Hardening + UAT** | 16–17 | AI eval harness in CI, cost review, Greenberg UAT re-quoting 5 real historical jobs, go-live | Production cutover |

Sequencing rationale: screens before chat (chat is a UX layer over the same tools); engines before ingestion (hand-seeded FAS proves the loop week 4, not week 12); ingestion before chat (RAG makes chat useful day one). If timeline pressure hits, cut from the top (Phase 5), never the middle. Phases 1–3 map to the ₹3.0L Standard MVP proposal scope plus structured screens.

## 6. Testing & verification

- **Engines — golden-file tests** (backbone): fixture enquiries → frozen BOM/pricing/ratio outputs; diffs fail CI with readable tables; Phase 6 adds 5 real historical projects with Greenberg-verified totals as goldens.
- **Property tests (fast-check)**: ratio flagged iff outside [1.35, 1.51]; totals = Σ lines exactly (integer paise); margin gate monotonicity; as-of-date price lookup returns exactly one rate (exclusion constraint).
- **Expr engine**: table-driven per operator/function + adversarial suite (`__proto__`, member access, node bombs) asserting rejection.
- **Audit/versioning invariants** (testcontainers Postgres): every transition emits its event in-transaction; UPDATE/DELETE on audit/locked versions raises; diff round-trips.
- **PDF**: Playwright screenshot-diff of the HTML template + text-layer assertions (totals, GSTIN, estimate no.) via pdf-parse — no binary snapshots. **Excel**: generate → re-parse → assert cells/formulas/formats.
- **AI eval harness** (nightly): extraction P/R on 30 hand-labeled docs gates prompt changes; scripted slot-filling conversations assert final enquiry JSON; router accuracy on labeled utterances. Prompt versions tracked in extraction_runs.
- **E2E (Playwright)**: form → draft → edit → approve → PDF in GCS → stub dispatch recorded.
- **Manual verification per phase**: each phase's "demoable outcome" column is the acceptance gate, demonstrated on the deployed Cloud Run URL.

## 7. Top risks & mitigations

1. **Design-rule quality is the product** → rules are Greenberg-authored data with save-time dry-runs; every line carries rule_code + standard_reference; UAT re-quotes 5 known jobs; start FAS-only, expand per validated system.
2. **Extraction errors poisoning masters** → hard human verification queue, confidence + arithmetic cross-checks, provenance on every row, eval harness gates prompt drift.
3. **Scope trap for a small team** → phases 1–3 are a complete shippable product with zero AI; chat/ingestion are additive.
4. **User-authored expressions as attack/DoS surface** → whitelisting interpreter, node caps, admin-only editing, adversarial CI suite.
5. **Audit integrity bugs found late** → DB-level enforcement + same-transaction writes + invariant tests from Phase 2 day one.
6. **LLM cost creep** → router sends cheap intents to Flash; llm_calls cost logging + dashboard tile; Opus only via explicit triggers; prompt caching keyed on master hash.
7. **WhatsApp vendor risk** → adapter + stub; provider picked by env flag at contract time.
8. **Rate staleness after historical seed** → dashboard flags aged rates; generation warns on rates older than N days.
9. **Cloud SQL cost vs grant** → smallest tier, pgvector over a second search product, worker min-instances 0.
10. **Estimator adoption** → review grid in their hands week 7; every AI answer cites rules/standards/sources; MCP boundary keeps Module 02 swappable as Pebble grows.

## 8. Deliverables of this session (first implementation slice)

Given this is a greenfield repo on branch `claude/fire-safety-boq-webapp-f5n921`, the immediate build starts with Phase 0 + as much of Phase 1 as fits: monorepo scaffold (apps/web, apps/worker, all packages), Drizzle schema + migrations for all tables above, expr engine + tests, engines B.01–B.03 + golden tests, seed script with starter FAS materials/makes/rates/rules drawn from the corpus analysis, enquiry form + generate flow + draft grid, admin CRUD scaffolding, Dockerfiles + GitHub Actions. Committed and pushed to the designated branch with clear messages.
