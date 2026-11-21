# Pebble Ops Runbook

Concise reference for the go-live team operating Pebble in production.

## Add/remove a teammate

`PEBBLE_ALLOWED_EMAILS` is a GitHub repo variable baked into Cloud Run at deploy time.

Standard path (rebuilds/redeploys, source of truth stays in sync):

```bash
gh variable set PEBBLE_ALLOWED_EMAILS --body "a@x.com,b@x.com" --repo softpipersolutions/INFRAQ
gh workflow run deploy.yml
```

Fast path (no rebuild, applies immediately to the running service):

```bash
gcloud run services update pebble-web --region=asia-south1 \
  --update-env-vars='^|^PEBBLE_ALLOWED_EMAILS=a@x.com,b@x.com'
```

The `^|^` delimiter is REQUIRED because the value contains commas. If you use the fast path, also update the repo variable — otherwise the next deploy reverts the change.

The first allowlisted email to sign in automatically becomes admin; every later sign-in becomes an estimator. Promote users to other roles at `/admin/users`.

Optional: set `PEBBLE_ALLOWED_DOMAIN` (a repo variable, wired the same way) to allow an entire email domain instead of listing individual addresses. An unset value renders empty and is treated as disabled.

## Roles

- **admin** — manages masters (materials, makes, prices, design rules), manages users, manages ingestion queue.
- **approver** — approves estimates.
- **estimator** — creates and edits estimates.

## Deploy

A push to `main` triggers `.github/workflows/deploy.yml`, guarded by the repo variable `DEPLOY_ENABLED=true`. Deploy order: migrate → worker → web.

Manual trigger:

```bash
gh workflow run deploy.yml
```

## Logs

```bash
gcloud run services logs read pebble-web --region=asia-south1
gcloud run services logs read pebble-worker --region=asia-south1
```

## Ingestion queue triage

`/admin/ingestion/queue` — currently 25 thin records await review. Approve, edit, or reject each record. Keyboard shortcuts: `a` approve, `e` edit, `r` reject, `m` more, `Shift+A` bulk approve.

## UAT procedure (Phase D)

Re-quote 5 real historical jobs via the chat interface or the enquiry form. Compare the resulting estimates against the original proposals and sign off on totals. Engineering then freezes these jobs as engine goldens (regression fixtures).

## Chat features & flags

The chat overhaul (Phase C.5) added four env vars, all read per-turn from `process.env` in `apps/web/src/server/chat-agent.ts` — no restart-only config, so a live flip via `gcloud run services update` takes effect on the very next request.

| Flag | Values | What it does |
|---|---|---|
| `PEBBLE_CACHE_TTL` | `5m` (default) / `1h` | The Anthropic prompt-cache lifetime for the two cache breakpoints (the master-digest system block + the per-turn user message). `1h` trades a pricier cache write for fewer cache misses on slower-paced conversations. |
| `PEBBLE_SKILLS_LANE` | unset (default) / `1` | Turns on `analyze_office_file` + `generate_file` (Office file analysis/generation via Anthropic's code-execution + Office skill, producing DRAFT working files only — never an official document). Also needs a live `ANTHROPIC_API_KEY`; without one the tools silently stay uncomposed even with the flag on. |
| `PEBBLE_TOOL_SEARCH` | unset (default) / `1` | Pilot seam for Anthropic's server-side tool-search + `defer_loading`. The pinned `@ai-sdk/anthropic` version doesn't yet ship the factory, so today this just logs a one-time warning and behaves identically to the flag being off — safe to leave on. |
| `PEBBLE_ADVISOR` | unset (default) / `1` | Pilot seam for Anthropic's beta advisor tool (a cheaper Sonnet-executor + Opus-advisor alternative to a full Opus escalation). Same story as `PEBBLE_TOOL_SEARCH` — logs a warning, falls back to the existing Sonnet/Opus model switch. Safe to leave on. |

### Flip a flag

Fast path (no rebuild, applies immediately to the running service):

```bash
gcloud run services update pebble-web --region=asia-south1 \
  --update-env-vars=PEBBLE_SKILLS_LANE=1
```

To persist it across the next deploy, also set the matching GitHub repo variable the deploy workflow reads (same pattern as `PEBBLE_ALLOWED_EMAILS` above) — otherwise the next `gh workflow run deploy.yml` reverts the fast-path change:

```bash
gh variable set PEBBLE_SKILLS_LANE --body "1" --repo softpipersolutions/INFRAQ
```

Note: flipping `PEBBLE_SKILLS_LANE` (or, once a provider ships support, `PEBBLE_TOOL_SEARCH`/`PEBBLE_ADVISOR`) changes the composed TOOL set, which is a cache-bust event exactly like a tool-definition code change (see PROGRESS.md's "cache-bust deploy rule") — the first turn on every active session after the flip pays a full cache write instead of a cheap read. Prefer flipping these alongside a deploy rather than as a standalone mid-day toggle.

### Memory

Cross-session memory needs no flag — the `memory` tool is composed on every chat turn (like `ask_user`), and the Anthropic SDK attaches the required memory beta header automatically whenever the tool is present. Users manage their own stored memory at **`/settings/memory`** (view/delete). The bytes live in the **`memory_files`** table (`packages/db/src/schema/memory.ts`) — one row per `(user_id, path)`, every path under the virtual `/memories/` tree, capped at 4 KB/file, 20 files, 64 KB total per user. Memory never holds prices or rates (the masters own pricing) — only durable client preferences, recurring specs, and correction patterns.

## Secrets

`DATABASE_URL`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_GENERATIVE_AI_API_KEY` live in GCP Secret Manager under project `example-project`. They are never stored in the repo.
