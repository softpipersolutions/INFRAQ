-- In-app allowlist management + access requests. Applied after 0006 by
-- src/migrate.ts, running identically on Cloud SQL Postgres 16 and the PGlite
-- dev/test driver (CREATE TABLE IF NOT EXISTS, so a re-run is a clean no-op —
-- same idempotency style as 0004/0005/0006).
--
-- allowed_emails is the DB-managed sign-in allowlist an admin edits from
-- Admin → Access at RUNTIME, with no redeploy. It sits in a UNION with the
-- deploy-baked env allowlist (PEBBLE_ALLOWED_EMAILS / PEBBLE_ALLOWED_DOMAIN):
-- a sign-in is authorised if the env check passes OR there is an `active` row
-- here. With BOTH empty the app stays FAIL-CLOSED — every login is denied, so a
-- misconfigured deployment never accepts arbitrary Google accounts. `email` is
-- the primary key, stored LOWERCASED, so the per-request union check is a single
-- indexed PK hit. Deactivating a row (active = false) revokes access on the
-- offender's NEXT request, exactly like removing them from the env list.
--
-- access_requests logs every DENIED sign-in attempt so an admin can approve it
-- from the dashboard without a redeploy or CLI. One row per email (lowercased
-- PK); a repeat attempt bumps attempt_count + last_seen and KEEPS the earliest
-- first_seen. status starts PENDING and moves to APPROVED / DENIED via the admin
-- UI. A re-attempt NEVER resurrects a DENIED row back to PENDING — a rejection
-- stays rejected until an admin explicitly flips it. status is plain text
-- (PENDING | APPROVED | DENIED) rather than a pg enum so the value set can grow
-- without a type migration; the repo + zod own the closed set.

CREATE TABLE IF NOT EXISTS "allowed_emails" (
  "email" text PRIMARY KEY,
  "added_by" text NOT NULL,
  "note" text,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "access_requests" (
  "email" text PRIMARY KEY,
  "display_name" text,
  "first_seen" timestamptz NOT NULL DEFAULT now(),
  "last_seen" timestamptz NOT NULL DEFAULT now(),
  "attempt_count" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'PENDING'
);
