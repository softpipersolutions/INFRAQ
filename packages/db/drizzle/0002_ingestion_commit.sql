-- Phase B ingestion commit layer — additive schema for committing reviewed
-- staged_records to the masters with provenance, plus material dedup embeddings
-- and the hot-path indexes the verification queue reads on. Applied after 0001
-- by src/migrate.ts. Runs identically on Cloud SQL Postgres 16 and the PGlite
-- dev/test driver.
--
-- NOTE on ALTER TYPE ... ADD VALUE: Postgres 12+ (and PGlite) allow adding an
-- enum value inside the implicit transaction of a multi-statement batch as long
-- as the new value is not USED in that same transaction. This migration only
-- ADDs 'STAGED_COMMITTED'; the first insert that uses it happens in a later
-- transaction, so the whole file applies cleanly through migrate.ts's single
-- exec() on both drivers (verified on PGlite).

ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'STAGED_COMMITTED';--> statement-breakpoint
ALTER TABLE "makes" ADD COLUMN "source_provenance" jsonb;--> statement-breakpoint
ALTER TABLE "prices" ADD COLUMN "source_provenance" jsonb;--> statement-breakpoint
ALTER TABLE "install_rates" ADD COLUMN "source_provenance" jsonb;--> statement-breakpoint
CREATE TABLE "material_name_embeddings" (
  "material_code" text PRIMARY KEY REFERENCES "materials"("material_code") ON DELETE CASCADE,
  "embedding" vector(768) NOT NULL,
  "model" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "source_documents_storage_uri_key" ON "source_documents" ("storage_uri");--> statement-breakpoint
CREATE INDEX "staged_records_status_created_idx" ON "staged_records" ("status","created_at");--> statement-breakpoint
CREATE INDEX "staged_records_run_idx" ON "staged_records" ("extraction_run_id");--> statement-breakpoint
CREATE INDEX "rag_chunks_source_document_idx" ON "rag_chunks" ("source_document_id");--> statement-breakpoint
CREATE INDEX "materials_name_trgm_idx" ON "materials" USING gin ("material_name" gin_trgm_ops);
