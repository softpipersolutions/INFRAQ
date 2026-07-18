-- Pebble integrity layer — invariants Drizzle cannot express in schema DSL.
-- Applied after 0000 by src/migrate.ts. Runs identically on Cloud SQL Postgres
-- 16 and the PGlite dev/test driver (verified: EXCLUDE-gist, generated tsvector,
-- HNSW, and plpgsql RAISE triggers are all supported).

-- ---------------------------------------------------------------------------
-- 1. Append-only / immutable triggers
-- ---------------------------------------------------------------------------

-- Generic guard: abort any UPDATE/DELETE it is attached to.
CREATE OR REPLACE FUNCTION pebble_raise_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

-- audit_events: never updated or deleted (spec section D — the app role holds
-- INSERT/SELECT only in prod; the trigger enforces it even for a superuser).
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION pebble_raise_immutable();--> statement-breakpoint

-- estimate_versions: immutable once LOCKED. The WORKING->LOCKED transition is
-- itself an UPDATE, but OLD.state is 'WORKING' then, so the guard lets it pass;
-- every mutation of an already-LOCKED snapshot is blocked.
CREATE TRIGGER estimate_versions_locked_immutable
  BEFORE UPDATE OR DELETE ON estimate_versions
  FOR EACH ROW WHEN (OLD.state = 'LOCKED')
  EXECUTE FUNCTION pebble_raise_immutable();--> statement-breakpoint

-- estimate_lines: a line whose parent version is LOCKED cannot be edited or
-- removed. INSERT is intentionally NOT guarded so generation can write a LOCKED
-- v1's lines; edits only ever target WORKING versions.
CREATE OR REPLACE FUNCTION pebble_block_locked_line() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE parent_state text;
BEGIN
  SELECT state INTO parent_state FROM estimate_versions
    WHERE id = OLD.estimate_version_id;
  IF parent_state = 'LOCKED' THEN
    RAISE EXCEPTION 'estimate_lines of a LOCKED version are immutable (line %, version %)',
      OLD.id, OLD.estimate_version_id USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER estimate_lines_locked_immutable
  BEFORE UPDATE OR DELETE ON estimate_lines
  FOR EACH ROW EXECUTE FUNCTION pebble_block_locked_line();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Temporal rate integrity — no overlapping validity ranges
-- ---------------------------------------------------------------------------
-- A NULL valid_to means the open-ended current rate; tstzrange(from, NULL) is
-- [from, infinity), so two current rows for one key overlap and are rejected —
-- guaranteeing an as-of lookup returns exactly one rate.
ALTER TABLE prices
  ADD CONSTRAINT prices_no_overlapping_validity
  EXCLUDE USING gist (
    material_code WITH =,
    make_code WITH =,
    tstzrange(valid_from, valid_to) WITH &&
  );--> statement-breakpoint

ALTER TABLE install_rates
  ADD CONSTRAINT install_rates_no_overlapping_validity
  EXCLUDE USING gist (
    rate_code WITH =,
    tstzrange(valid_from, valid_to) WITH &&
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Retrieval structures on rag_chunks (hybrid vector + keyword search)
-- ---------------------------------------------------------------------------
ALTER TABLE rag_chunks
  ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;--> statement-breakpoint

CREATE INDEX rag_chunks_content_tsv_idx ON rag_chunks USING gin (content_tsv);--> statement-breakpoint
CREATE INDEX rag_chunks_embedding_hnsw_idx ON rag_chunks
  USING hnsw (embedding vector_cosine_ops);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Hot-path lookup indexes
-- ---------------------------------------------------------------------------
-- Current-rate lookups (the engine's B.02 path) hit valid_to IS NULL rows.
CREATE INDEX prices_current_idx ON prices (material_code, make_code)
  WHERE valid_to IS NULL;--> statement-breakpoint
CREATE INDEX install_rates_current_idx ON install_rates (rate_code)
  WHERE valid_to IS NULL;--> statement-breakpoint
CREATE INDEX install_rates_linked_material_idx ON install_rates (linked_material)
  WHERE valid_to IS NULL;--> statement-breakpoint
-- Active rules per system (B.01 rule selection).
CREATE INDEX design_rules_active_system_idx ON design_rules (system_type)
  WHERE active = true;--> statement-breakpoint
CREATE INDEX makes_material_idx ON makes (material_code);--> statement-breakpoint
CREATE INDEX estimate_lines_version_idx ON estimate_lines (estimate_version_id, section_order, line_order);--> statement-breakpoint
CREATE INDEX estimate_versions_estimate_idx ON estimate_versions (estimate_id, version_no);--> statement-breakpoint
CREATE INDEX estimates_enquiry_idx ON estimates (enquiry_id);
