# Pebble Module 02 — Infrastructure (GCP)

Deployment target for Pebble v1.0 Module 02 (fire-safety BOQ app). Local dev
needs **zero cloud credentials** (PGlite + stub email/WhatsApp + stub PDF); this
guide covers the **production GCP** footprint. Region below is `asia-south1`
(Mumbai) — closest to the Lucknow user base.

## Components

| Service | GCP product | Notes |
|---|---|---|
| Web (`@pebble/web`) | Cloud Run | Next.js 15 standalone image (`Dockerfile.web`). Public, behind Firebase Auth. |
| Worker (`@pebble/worker`) | Cloud Run | Hono service (`Dockerfile.worker`) with headless Chromium for PDF. `min-instances=0`. |
| Database | Cloud SQL for PostgreSQL 16 | Extensions: `vector`, `pg_trgm`, `btree_gist`. Smallest tier to start. |
| Object storage | Cloud Storage (GCS) | Rendered PDFs/XLSX; signed URLs (7-day). |
| Task queues | Cloud Tasks | Three queues: `ingest`, `generate-output`, `dispatch`. |
| Auth | Firebase Authentication | Google sign-in; roles `admin` / `estimator` / `approver`. |
| Secrets | Secret Manager | API keys, DB URL, provider creds. |

## 1. Project + APIs

```bash
gcloud config set project "$GCP_PROJECT"
gcloud services enable \
  run.googleapis.com sqladmin.googleapis.com storage.googleapis.com \
  cloudtasks.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com
```

## 2. Artifact Registry

```bash
gcloud artifacts repositories create pebble \
  --repository-format=docker --location=asia-south1 \
  --description="Pebble container images"
```

Images: `asia-south1-docker.pkg.dev/$GCP_PROJECT/pebble/web` and `.../pebble/worker`.

## 3. Cloud SQL (Postgres 16)

```bash
gcloud sql instances create pebble-pg \
  --database-version=POSTGRES_16 --region=asia-south1 \
  --tier=db-g1-small --storage-type=SSD --storage-size=10GB
gcloud sql databases create pebble --instance=pebble-pg
gcloud sql users create pebble --instance=pebble-pg --password="$DB_PASSWORD"
```

Enable the extensions the migrations require (run once, as a superuser):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

`DATABASE_URL` uses the Cloud SQL connector socket on Cloud Run, e.g.
`postgresql://pebble:<pw>@/pebble?host=/cloudsql/$GCP_PROJECT:asia-south1:pebble-pg`.

## 4. Migrations as a pre-deploy job

Migrations must run **before** new revisions serve traffic. Run the `@pebble/db`
migrator (`src/migrate.ts`) as a Cloud Run **job** wired to the DB, and gate the
deploy on it (see `.github/workflows/deploy.yml`):

```bash
gcloud run jobs create pebble-migrate \
  --image=asia-south1-docker.pkg.dev/$GCP_PROJECT/pebble/worker \
  --region=asia-south1 \
  --set-cloudsql-instances="$GCP_PROJECT:asia-south1:pebble-pg" \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest \
  --command=node --args=--import,tsx,../packages/db/src/migrate.ts
gcloud run jobs execute pebble-migrate --region=asia-south1 --wait
```

Migrations are idempotent (tracked in `__pebble_migrations`), so re-running is safe.

## 5. GCS buckets

```bash
gcloud storage buckets create gs://$GCP_PROJECT-pebble-outputs --location=asia-south1
gcloud storage buckets create gs://$GCP_PROJECT-pebble-ingest  --location=asia-south1
```

- `pebble-outputs` — rendered Format A PDF/XLSX (`STORAGE_BACKEND=gcs`, `GCS_BUCKET`).
- `pebble-ingest` — historical corpus uploads for the ingestion pipeline (Phase 4).

Grant the worker service account `roles/storage.objectAdmin` on `pebble-outputs`.
Signed URLs need the SA to have `roles/iam.serviceAccountTokenCreator`.

## 6. Cloud Tasks queues

```bash
for q in ingest generate-output dispatch; do
  gcloud tasks queues create "pebble-$q" --location=asia-south1
done
```

Tasks POST to the worker routes: `generate-output → /tasks/render`,
`dispatch → /tasks/dispatch`, `ingest → /tasks/ingest` (stub until Phase 4).
Use OIDC tokens so only the queues' SA can invoke the worker.

## 7. Firebase Auth + roles

Enable Firebase Authentication (Google provider) on the same GCP project.
Roles are carried as custom claims (`admin` / `estimator` / `approver`); the web
app runs with `AUTH_MODE=firebase` in production and `AUTH_MODE=dev` locally
(returns a dev admin, zero cloud creds).

## 8. Secret Manager

Create one secret per sensitive value and mount them into the Cloud Run
services (see `.env.example` for the full list):

```bash
printf '%s' "$DATABASE_URL" | gcloud secrets create DATABASE_URL --data-file=-
# …ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, RESEND_API_KEY,
#   AISENSY_API_KEY / GUPSHUP_API_KEY, Firebase admin creds, etc.
```

## 9. Deploy the services

```bash
# Web
gcloud run deploy pebble-web \
  --image=asia-south1-docker.pkg.dev/$GCP_PROJECT/pebble/web \
  --region=asia-south1 --allow-unauthenticated \
  --set-cloudsql-instances="$GCP_PROJECT:asia-south1:pebble-pg" \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest \
  --set-env-vars=AUTH_MODE=firebase,STORAGE_BACKEND=gcs,GCS_BUCKET=$GCP_PROJECT-pebble-outputs,WORKER_URL=$WORKER_URL

# Worker (Chromium image; a little more memory for rendering, scales to zero)
gcloud run deploy pebble-worker \
  --image=asia-south1-docker.pkg.dev/$GCP_PROJECT/pebble/worker \
  --region=asia-south1 --no-allow-unauthenticated \
  --memory=2Gi --cpu=1 --min-instances=0 \
  --set-cloudsql-instances="$GCP_PROJECT:asia-south1:pebble-pg" \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest,RESEND_API_KEY=RESEND_API_KEY:latest \
  --set-env-vars=STORAGE_BACKEND=gcs,GCS_BUCKET=$GCP_PROJECT-pebble-outputs,RENDER_PDF=1
```

CI/CD is in `.github/workflows/`: `ci.yml` (typecheck + test + web build on every
push/PR) and `deploy.yml` (build + push both images and deploy to Cloud Run on
`main`, with the migration job as a pre-deploy step). The deploy workflow is
guarded off until the GCP secrets are wired — see its header.
