# Pebble v1.0 — Module 02: Estimate Crafting Space

Fire-safety BOQ/estimate platform for **Greenberg Enterprises** (Lucknow), built by **Softpiper Solutions**. Turns a building enquiry into a professional, auditable fire-safety estimate: **enquiry → deterministic auto-draft → human review → Greenberg-format BOQ (PDF/Excel) → dispatch**, with an immutable audit trail underneath.

Core business rule: **SITC = Supply × 1.43** (acceptance band 1.35–1.51, enforced by engine B.03).

## Architecture

- **Deterministic core** — every rupee figure comes from pure TypeScript engines (`packages/engines`): design rules → BOM (B.01), pricing + margin (B.02), SITC validation (B.03). LLMs never compute prices.
- **Two AI lanes** (`packages/ai`) — Gemini Flash for retrieval/extraction/RAG; Claude (Sonnet default, **Opus 4.8** escalation) for interpretation, drafting and explanations. A router assigns each turn; COMPUTE-class work always goes to the engines.
- **Safe rules engine** (`packages/expr`) — Greenberg staff author rules like `building_type = Commercial AND floor_area_sqm <= 500` / `CEIL(total_area_sqm / 60)`; jsep-based whitelisting interpreter, no eval, node/depth caps.
- **Integrity by construction** (`packages/db`) — append-only audit (Postgres triggers), copy-on-write estimate versions with stable line UIDs (powers version diff), non-overlapping rate validity (exclusion constraints), denormalized line snapshots.
- **Deploy target** — GCP: Cloud Run (web + worker) + Cloud SQL Postgres 16 (pgvector) + Cloud Storage + Firebase Auth. Local dev runs on **PGlite with zero cloud credentials**.

## Monorepo layout

```
apps/
  web/        Next.js 15 — UI + tRPC API + chat (dashboard, enquiry form, draft grid, masters admin, audit timeline)
  worker/     Hono — Cloud Tasks handlers: PDF/Excel rendering (Chromium), dispatch, ingestion
packages/
  shared/     Contracts: enums, constants, money (integer paise), unit normalizer, zod schemas (A.01–A.08)
  expr/       Safe expression engine for design rules (A.06)
  engines/    Deterministic engines B.01–B.03 + margin gate (pure, zero I/O)
  db/         Drizzle schema, migrations, repositories, seed (pg + PGlite)
  ai/         Model router, slot-filling, prompts, tool definitions (Vercel AI SDK)
  documents/  Format A BOQ: HTML template (→PDF) + Excel builder
  dispatch/   Email (Resend) + WhatsApp (AiSensy/Gupshup) adapters with stub providers
  mcp/        Module 02 exposed over MCP (Pebble module boundary)
infra/        Dockerfiles, GCP setup guide, GitHub Actions
```

## Quickstart (local, no cloud credentials)

```bash
pnpm install
pnpm db:migrate && pnpm db:seed   # PGlite at .data/pglite by default
pnpm --filter @pebble/web dev     # http://localhost:3000 — dev auth, seeded masters
```

Create an enquiry from the UI; a priced draft (v1, locked) is generated deterministically and opens in the review grid with SITC/margin gates. See `.env.example` for Postgres/Firebase/AI keys when moving beyond dev mode.

## Source documents

- `pebble-v1-module-02-estimate-crafting-space.html` — Module 02 technical spec (data model A.01–A.08, engines B.01–B.03, Format A/B, 14-event audit trail).
- `Amitabh Fire Safety BOQ Data/` — 145 historical Greenberg proposals (2022–2026) used to seed masters and power "what did we quote before?" retrieval.

---

Greenberg Enterprises × Softpiper Solutions · Pebble v1.0
