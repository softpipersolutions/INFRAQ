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

## Secrets

`DATABASE_URL`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_GENERATIVE_AI_API_KEY` live in GCP Secret Manager under project `infraq-greenberg`. They are never stored in the repo.
