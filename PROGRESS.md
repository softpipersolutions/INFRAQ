# Pebble Module 02 — Build Progress & Continuation Guide

> **Purpose of this file:** hand off the build to a fresh Claude Code session (local or remote) with zero context loss. Read this top-to-bottom, then follow "How to continue" at the end. The full approved architecture/build plan is in **`docs/PLAN.md`** — read that too before writing code.

Last updated: 2026-07-21 · Branch: `claude/fire-safety-boq-webapp-f5n921`

> ## 💬 CHAT OVERHAUL COMPLETE (2026-07-21)
> Six work packages (WP6–WP13) layered onto the Phase C.5 agentic chat foundation are done; **WP14 (this entry) closes the overhaul** with the last 5 live-eval scenarios plus this documentation. What shipped:
> - **Multi-session chat** — `/chat/[sessionId]` + a sidebar (list/rename/pin/archive, newest-active-first) + auto-generated titles (Gemini Flash, one-shot off the first user turn). Every session router procedure is strict owner-only: a non-owner — including an admin — gets `NOT_FOUND`, never `FORBIDDEN` (no existence leak).
> - **Flagship UX polish** — markdown rendering, tool-activity icons/rows, word-paced streaming (`smoothStream({chunking:"word"})`), and a tolerant reload of persisted tool/text parts (see the `v:1` contract below).
> - **Structured clarification (`ask_user`)** — a module-agnostic, agent-CORE tool (`packages/ai/src/agent/ask-user.ts`) with deliberately **NO executor**: the call itself IS the rendered 2–4 option menu, and the absence of a tool result ends the turn AT the question (`stopWhen: [stepCountIs(8), hasToolCall(ASK_USER_TOOL_NAME)]` in `chat-agent.ts` is belt-and-braces for exactly this). The user's tapped chip — or free text, when `allowFreeText` is true — arrives as their next message.
> - **Attachments** — upload routes + document/image content blocks with a pre-flight token/cost guard (`ATTACHMENT_TOKEN_LIMIT`, refuses an over-budget batch naming the single biggest file before any model call ever runs); `list_attachments`/`read_attachment` re-read an earlier upload without re-embedding it on the message. Flagged skills lane (`PEBBLE_SKILLS_LANE=1`, also needs a live `ANTHROPIC_API_KEY`): `analyze_office_file` (Office code-execution + skill over an xlsx/docx/pptx) and `generate_file` (a DRAFT xlsx/docx/pptx working file — **never** an official document; those come only from `prepare_documents` on a LOCKED estimate).
> - **Cross-session memory** — Anthropic's provider-defined `memory_20250818` tool (`packages/ai/src/agent/memory.ts`), composed on every turn exactly like `ask_user`. WE own the bytes (a per-user Postgres store behind `/settings/memory`, table `memory_files`); Claude drives the `view`/`create`/`str_replace`/`insert`/`delete`/`rename` protocol it is already trained on over a virtual `/memories/` tree. Every path is validated (rejects `..`, absolute escapes, backslashes, null bytes — never throws, always an instructive `Error: …` string) and capped (4 KB/file, 20 files, 64 KB total per user). Never stores prices or rates — preferences and correction patterns only.
> - **Robustness** — abort persistence (a client Stop/disconnect persists the partial turn plus a `data-stopped` marker, with no summary refresh and no auto-title on that turn); the 429 daily-budget guard's JSON body carries `resetsAtISO` (the next UTC-midnight instant) so the composer renders a live countdown instead of a static message; `chat_messages.parts` is the tolerant-reader `v:1` contract described below.
> - **Cost/perf seams** — `PEBBLE_CACHE_TTL` (the one env → both prompt-cache breakpoints), plus two flagged pilots that are implemented-but-functionally-off pending provider support: `PEBBLE_TOOL_SEARCH` and `PEBBLE_ADVISOR`.
>
> **The four env flags this phase introduced:**
>
> | Flag | Default | What it does | Status |
> |---|---|---|---|
> | `PEBBLE_CACHE_TTL` | `5m` | Picks the Anthropic ephemeral prompt-cache lifetime for BOTH cache breakpoints this app sets (the master-digest SYSTEM block, `prompts.ts`; the per-turn USER message, `chat-agent.ts`). `resolveCacheTtl`/`ephemeralCacheControl` (`packages/ai/src/cache.ts`) is the single source of truth, so the two breakpoints can never disagree. Set the literal string `1h` to opt into the longer (pricier-write, fewer-miss) tier; anything else — unset, empty, mistyped — falls back to 5m. | Live |
> | `PEBBLE_SKILLS_LANE` | off | `=1` composes `analyze_office_file`/`generate_file` (and needs a live `ANTHROPIC_API_KEY` too — `createSkillsLaneFromEnv` returns `null` without one, silently keeping the tools uncomposed). With the flag off the two tools have no schema at all — zero prompt-token cost, not just "hidden". | Live (flagged) |
> | `PEBBLE_TOOL_SEARCH` | off | `=1` is the WP11 pilot seam for Anthropic's server-side tool-search + `defer_loading` (every composed tool is already hot/cold-tagged — `registry.ts#AgentComposition.toolMeta`). The installed `@ai-sdk/anthropic` (2.0.86/2.0.87) ships no tool-search factory, so today the flag just logs `TOOL_SEARCH_UNSUPPORTED_WARNING` once per turn and streams the full, undeferred tool set — functionally identical to the flag being off. Flips on automatically the day `resolveToolSearchSupport()` reports a supported provider, with zero further code change. | Warn-and-fallback |
> | `PEBBLE_ADVISOR` | off | `=1` is the WP12 pilot seam for Anthropic's beta advisor tool (keep the Sonnet executor, hand it an Opus advisor mid-generation on an escalating turn — cheaper than a full Opus turn). The installed provider ships no advisor factory either, so the flag logs `ADVISOR_UNSUPPORTED_WARNING` once and falls back to the existing deterministic Sonnet/Opus model switch. The usage-ledgering half (`parseAdvisorIterations`, reading `providerMetadata.anthropic.iterations`) is real and tested today even though nothing can attach the tool yet. | Warn-and-fallback |
>
> **The `parts v:1` tolerant-reader contract.** Every persisted tool/text part on `chat_messages.parts` (jsonb) carries a `v:1` marker (`reconstructUiParts` in `chat-agent.ts`); the reload path (`history-to-ui-messages.tsx`) reads it tolerantly — an unknown/missing version, an unrecognised tool name, or a part shape left behind by a since-changed tool schema all degrade to a safe generic rendering instead of crashing the reload. This is what lets tool DEFINITIONS keep evolving release over release without a stale persisted part from an older deploy ever breaking a page load.
>
> **The cache-bust deploy rule.** The Anthropic prompt cache's first breakpoint sits on the master-digest system block, with the request's tool definitions serialized ahead of it — so ANY tool schema/description change (a new tool, a renamed field, a tweaked description) busts the cached prefix for every in-flight session the moment the new build serves a request: the first turn after that deploy always pays a full cache WRITE, not a cheap read, no matter how small the change was. Rule of thumb burned into this codebase: **batch multiple tool-definition changes into ONE deploy** rather than shipping them one-by-one across several deploys in a day — each deploy is one cache-bust event regardless of how many tool changes ride along, so bundling minimizes the number of full-price turns users pay for.
>
> **WP14 — the closing work package** (`apps/web/eval/conversations/*.ts`, this doc): 5 new live-eval scenarios bring the canonical suite to **13**: `clarification-flow` (`ask_user` offers 2–4 option chips and the turn ends AT the question — no `create_enquiry`, no invented values, no `output-available` on the `ask_user` part; answering with one option's own label lets capture proceed), `file-analysis-turn` (a fixture CSV attached via the same storage + `insertChatAttachment` path the upload route uses is embedded and read back accurately, with no OTHER invented figures), `file-generation-turn` (`PEBBLE_SKILLS_LANE`-gated; SKIPs cleanly — a `pass:true, skipped:true` row, never a failure — when the flag/key isn't live; when it is, asserts `generate_file` succeeds and the hand-off is explicitly marked a DRAFT), `memory-recall-across-sessions` (a durable preference stated in session 1 either gets written to memory or is logged as model discretion — never hard-failed either way; a brand-new session 2 has zero slot-state side effects and reflects the preference whenever session 1 actually wrote it), `multi-session-isolation` (a second user asking about "my draft" never sees another user's confirmed values, their own session state stays the untouched baseline, and direct history access to the other user's session id is `NOT_FOUND`). The runner (`scripts/chat-agent-eval.ts`) now prints the full registered scenario list even on the no-keys `exit(2)` path (part of the setup instructions, not gated behind having keys), and reports a `SKIP` row distinctly from `PASS`/`FAIL` in both the per-case output and the summary line. **Suites verified green**: web 251 · ai 274 · db 106 (unchanged counts — WP14 deliberately adds zero unit tests, only eval scenarios + docs, per scope); `pnpm -r typecheck` clean across all 10 workspace packages, eval files confirmed present in the `apps/web` tsc program; the eval runner without keys still exits 2 with setup instructions and lists all 13 scenario names, and never makes a live call before that exit.
>
> ## ✅ STAGED QUEUE DRAINED — GEMINI FULL AUTO-APPROVE (2026-07-20)
> The founder chose full auto-approval over a manual G6 review of the 3,560
> PROPOSED staged records. A second-pass Gemini 3.5 Flash audit
> (`packages/ai/src/ingest/verify.ts`, prompt `staged-verify-v2` — a genuine
> temperature-0 gate: approve/reject/unsure, never an editor) ran over the
> whole queue via `POST /tasks/auto-approve` (`apps/worker/src/auto-approve.ts`,
> driver `apps/worker/scripts/auto-approve-drive.ts`). **Final: 2,081 approved
> · 1,454 rejected · 25 left PROPOSED for humans (of 3,560), total model cost
> ≈ $1.22.** Every decision is stamped `reviewedBy: "gemini-auto"`, ledgered in
> `llm_calls` (intent `staged-verify`), and committed through the same audited
> `commitStagedRecord` path humans use. The rejects are real catches, not
> noise: Novec 1230 suppression rows misfiled as FAS/Panel, "UL listed"
> stripped from material names, section-header categories (a 150 mm pipe filed
> as "Pump"), and **same-day duplicate prices** — a duplicate for one
> (material, make) violates `prices_no_overlapping_validity` on every retry
> (only one price per pair per instant exists by design; the first commit won),
> so the batch now detects the exclusion error across drizzle's cause chain and
> rejects it as `duplicate price point` instead of recycling it as unsure —
> the head-of-line-blocking fix that let the queue actually drain. The 25
> survivors are genuinely thin source lines ("SITC of 15 mm", "40 mm dia") a
> human should eyeball in /admin/ingestion/queue. Prompt lesson burned in
> (`staged-verify-v2`): the auditor sees ONLY the description cell — v1 marked
> hundreds unsure for prices/units living in table columns it was never shown.
>
> ## 🤖 PHASE C.5 — THE AGENTIC CHAT SYSTEM (2026-07-19)
> The templated slot-filling lane is gone. **Claude Sonnet 5 now owns every
> user-visible reply** and orchestrates the whole Module-02 workflow itself
> through **15 tools** (`packages/ai/src/agent/module02.ts`) — no
> `selectLane`/classifier/`buildSlotResponseText` script in between. Deleted:
> `selectLane`, the Gemini pre-triage classifier, `buildSlotResponseText`/
> `buildSlotRecap`, `COMPUTE_LANE_MESSAGE`, `routeTurn`/`INTENTS`. A single
> agent turn (`runAgentTurn` in `apps/web/src/server/chat-agent.ts`,
> `streamText` + `stepCountIs(8)`) composes persona → Module-02 tool
> fragments/policy → cached master digest, then the running summary + last-12
> verbatim turns + a session-state block (`agent/registry.ts`,
> `agent/context.ts` — the module-agnostic ERP seam every future INFRAQ module
> plugs into). Safety upgrades: **`create_enquiry` shrank to
> `{userConfirmed:true}`** — the record is now derived entirely from the
> session's captured slot state (`createEnquiryFromState`), so the model can no
> longer pass values diverging from what it showed the user; new
> `get_enquiry_state`/`repair_enquiry_state`/`reset_enquiry_capture` give the
> agent a conversational self-heal path for a stale/corrupt draft instead of
> silently pressing on. **Opus 4.8 escalation is deterministic and
> rate-guarded** (`agent/escalation.ts`): a challenge on a linked draft,
> confirmed-slot contradictions ≥2, or a review past 12 turns escalates —
> unless the per-user daily Opus cap (`PEBBLE_OPUS_DAILY_CAP_USD`, default $1)
> or a 5-escalated-turns/day cap is already hit, in which case it stays on
> Sonnet and ledgers the suppression (`agent-suppressed:budget[...]`).
> **Gemini 3.5 Flash keeps three jobs**: `extract_enquiry_fields` (long pasted
> text), embeddings, and running-summary compaction — `chat_sessions.summary` +
> `summary_upto_message_id` fold everything older than the last 12 turns into a
> ≤300-token watermarked digest (`agent/compaction.ts`), refreshed once >8
> turns go unsummarized. **Tool activity now survives a reload**:
> `chat_messages.parts` (jsonb) persists one part per tool call
> (`input-available` → `output-available`/`output-error`) plus text, so the UI
> can rehydrate live-activity rows and the post-creation receipt card exactly
> as they streamed. All safety invariants unchanged or tightened: LLMs still
> never compute money, never mutate an estimate (`propose_line_edit` stays
> suggestion-only), never approve/dispatch (human-button-only, no tool exists
> for either).
>
> **WP5 — the live conversation eval harness** (`apps/web/eval/**`,
> `apps/web/scripts/chat-agent-eval.ts`, script `eval:chat`): 8 canonical
> conversations against `runAgentTurn` directly (no HTTP) over a fresh
> PGlite db per case — happy path (one message → canonical slots → restate →
> confirm → exactly one enquiry + LOCKED v1 estimate, receipt part, a tolerant
> no-invented-numbers check against tool output/user text/master digest, cost
> and wall gates), incremental capture + mid-stream correction (contradiction
> counter stays 0 for a still-proposed field), a curveball recall question
> mid-capture (state untouched, capture resumes), challenge-the-draft ×2
> (Opus escalation ledgered, a rule/standard citation, zero estimate
> mutations), a pure recall turn (zero side effects), self-heal from the
> legacy padded-`systemsRequired` bug (`"Common"` leaking into a
> client-requested-systems slot), budget exhaustion (429, no new llm_calls
> row), and an explain walkthrough (`DL-FAS-001` + `IS 2189`/`per 60`, no
> invented figures). **Never run in CI** — it calls the real Anthropic +
> Gemini APIs. Run it with:
> ```bash
> ANTHROPIC_API_KEY=... GOOGLE_GENERATIVE_AI_API_KEY=... \
>   pnpm --filter @pebble/web eval:chat
> # or Vertex, and/or a single scenario:
> ANTHROPIC_API_KEY=... PEBBLE_AI_PROVIDER=vertex GOOGLE_VERTEX_PROJECT=example-project \
>   GOOGLE_VERTEX_LOCATION=global GOOGLE_VERTEX_ACCESS_TOKEN=$(gcloud auth print-access-token) \
>   pnpm --filter @pebble/web eval:chat -- --only happy-path
> ```
> Without keys it exits 2 with setup instructions, never confused with a real
> eval failure. **FULL SUITE: 8/8 PASS on real models (2026-07-19)** — happy
> path $0.055/41s, correction $0.020/22s, curveball, challenge (Opus
> ledgered, $0.60), recall $0.003, self-heal from the legacy padded-systems
> prod bug, budget 429 in 13ms, explain walkthrough with 9 number-tokens all
> grounded; typical turn 2-5¢. The one initial failure was a harness
> heuristic (restating the record ≠ re-asking), not the agent. DEPLOYED to
> production (migration 0003 applied via the pre-deploy job).
>
> ## 💬 PHASE C COMPLETE — CHAT LIVE (2026-07-19)
> The conversational lane is deployed: /chat streams through the
> deterministic-first router — Gemini (Vertex) fills A.08 slots with
> enum-constrained extraction (per-floor semantics + shared vocabularies,
> both fixed after real-model E2E caught free-text/total-area failures),
> **Claude Sonnet 5** (env: PEBBLE_CLAUDE_DEFAULT_MODEL) handles
> interpret/explain/recall with the Pebble tools, Opus 4.8 on escalation
> triggers, COMPUTE never touches a model. Verified live: one message →
> all slots canonical → confirm → GBE-EST-2026-001 via the same validated
> generate path; "why 30 smoke detectors?" → DL-FAS-001 + IS 2189 +
> CEIL(1800/60)=30 with resolved rates, all from tool facts. Per-user
> daily budget guard (PEBBLE_DAILY_LLM_BUDGET_USD, 429), clean 503
> without keys, every model call in the llm_calls ledger + dashboard
> tile. Explain buttons on estimate lines; master-digest prompt caching
> keyed on masterDigestHash. Suites: ai 111 · db 58 · web 41 (+ shared 88,
> worker 114, engines 31, expr 123, dispatch 24, documents 12 = 602).
> Remaining: Gate G6 queue review with Greenberg staff; Phase D UAT.
>
> ## 📚 PHASE B COMPLETE — CORPUS INGESTED (2026-07-19)
> All 145 historical proposals (142 PDF + 3 XLSX) extracted, normalized,
> dedup-routed and staged in production: **145/145 DONE**, ≈3.6k staged line
> proposals, ≈850 RAG chunks, total Vertex extraction cost < $1.
> Gates: G2 (stub E2E + resumability) ✅ · G3 eval on Vertex gemini-3.5-flash
> prompt pdf-extract-v1: precision 100% (fully-labeled fixtures), recall 100%
> (all 6 fixtures / 65 lines), fields 100% ✅ · G5 backfill 145/145 ✅.
> Extraction runs on **Vertex AI** (postpaid, IAM; PEBBLE_AI_PROVIDER=vertex —
> the Developer-API prepaid lane remains env-selectable). Live surfaces:
> /admin/ingestion (corpus dashboard), /admin/ingestion/queue (keyboard
> verification queue — a/e/r/m, Shift+A bulk), /history (hybrid RAG search
> with cited sources). Remaining: **G6** — Greenberg staff review session on
> the live queue (commit first tranche with provenance, spot-check 10 prices
> against source PDFs), then Phase C chat. Notable prod lessons burned in:
> NUL bytes from Gemini for unmappable glyphs (°C) crash real Postgres but
> not PGlite (scrubbed in normalizeLine); backfill driver needs no local
> bucket creds (uris derive from the corpus dir; gcloud user-token lane).
>
> ## 🚀 PHASE A DEPLOYED TO PRODUCTION (2026-07-19)
> Live on Cloud Run (project **example-project**, asia-south1):
> **web** https://pebble.greenberg.example (public, AUTH_MODE=firebase,
> Google sign-in, allowlist `PEBBLE_ALLOWED_EMAILS` repo var) · **worker**
> pebble-worker (private, OIDC-invoked, Chromium PDF, GCS outputs).
> Placeholder letterhead (GSTIN 09AAAAA0000A1Z5, brand marks, FF-149 T&C) ships in
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

User-confirmed decisions (do not re-litigate): full web app (forms + chat, Format B deferred), GCP + Firebase Auth, smart model routing, full ingestion+RAG of the 145 historical PDFs in `proposal-corpus/` (later phase).

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

## 7. Current status and what remains

The build is complete and live: `packages/shared`, `expr`, `db`, `engines`, `documents`, `dispatch`, `ai`, `apps/worker`, `infra`, and `apps/web` (core + admin) are all built, tested, and deployed via `.github/workflows/deploy.yml`.

For day-to-day operations (adding/removing teammates, roles, deploy, logs, ingestion queue triage, secrets), see **`docs/RUNBOOK.md`**.

What remains before full cutover:

1. **Ingestion queue** — 25 thin records awaiting review at `/admin/ingestion/queue` (approve/edit/reject).
2. **Phase D UAT + goldens** — re-quote 5 real historical jobs (chat or enquiry form), compare against original proposals, sign off totals; engineering then freezes them as engine goldens. See `docs/RUNBOOK.md` for the full procedure.
3. **Cutover** — once UAT is signed off and the queue is clear, switch the go-live team over to Pebble as the system of record.
