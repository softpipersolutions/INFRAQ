-- Extensions required by later columns/constraints: pgvector (embeddings),
-- pg_trgm (dedup similarity), btree_gist (scalar `=` inside gist EXCLUDE).
-- Available in Cloud SQL Postgres 16 and preloaded in the PGlite dev/test driver.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TYPE "public"."applicable_standard" AS ENUM('IS', 'NBC 2016', 'NFPA', 'UL Listed', 'FM Approved', 'Client Spec');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('Approved', 'Conditional', 'Blacklisted');--> statement-breakpoint
CREATE TYPE "public"."audit_event_type" AS ENUM('ENQ_CREATED', 'GEN_STARTED', 'RULE_APPLIED', 'PRICE_APPLIED', 'SITC_VALIDATED', 'DRAFT_v1_CREATED', 'REVIEW_STARTED', 'LINE_EDITED', 'LINE_ADDED', 'LINE_REMOVED', 'EST_APPROVED', 'OUTPUT_GENERATED', 'EST_DISPATCHED', 'EST_REVISED');--> statement-breakpoint
CREATE TYPE "public"."building_type" AS ENUM('Residential', 'Commercial', 'Industrial', 'Institutional', 'Mixed');--> statement-breakpoint
CREATE TYPE "public"."discount_authority" AS ENUM('Self', 'GM', 'MD');--> statement-breakpoint
CREATE TYPE "public"."dispatch_channel" AS ENUM('EMAIL', 'WHATSAPP');--> statement-breakpoint
CREATE TYPE "public"."dispatch_status" AS ENUM('QUEUED', 'SENT', 'DELIVERED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('PDF', 'XLSX');--> statement-breakpoint
CREATE TYPE "public"."enquiry_source" AS ENUM('form', 'chat');--> statement-breakpoint
CREATE TYPE "public"."estimate_status" AS ENUM('GENERATING', 'DRAFT', 'IN_REVIEW', 'APPROVED', 'DISPATCHED', 'REVISED');--> statement-breakpoint
CREATE TYPE "public"."install_rate_unit" AS ENUM('Per No.', 'Per Metre', 'Per Set', 'Per Floor', 'Lumpsum');--> statement-breakpoint
CREATE TYPE "public"."line_source" AS ENUM('RULE', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."make_preference" AS ENUM('Premium', 'Standard', 'Economy', 'As per Greenberg');--> statement-breakpoint
CREATE TYPE "public"."make_tier" AS ENUM('Premium', 'Standard', 'Economy');--> statement-breakpoint
CREATE TYPE "public"."margin_status" AS ENUM('OK', 'BELOW_FLOOR');--> statement-breakpoint
CREATE TYPE "public"."material_category" AS ENUM('Detector', 'Panel', 'Cable', 'Pipe', 'Valve', 'Pump', 'Fitting', 'Extinguisher', 'Accessory', 'Signage');--> statement-breakpoint
CREATE TYPE "public"."sitc_status" AS ENUM('PASS', 'ALERT');--> statement-breakpoint
CREATE TYPE "public"."staged_record_status" AS ENUM('PROPOSED', 'APPROVED', 'EDITED_APPROVED', 'REJECTED', 'MERGED');--> statement-breakpoint
CREATE TYPE "public"."system_type" AS ENUM('FAS', 'Hydrant', 'Sprinkler', 'Extinguisher', 'Suppression', 'Common');--> statement-breakpoint
CREATE TYPE "public"."unit_of_measure" AS ENUM('No.', 'Metre', 'Set', 'Kg', 'Litre', 'Lot', 'Man-day');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'estimator', 'approver');--> statement-breakpoint
CREATE TYPE "public"."version_state" AS ENUM('WORKING', 'LOCKED');--> statement-breakpoint
CREATE TABLE "design_rules" (
	"rule_id" text PRIMARY KEY NOT NULL,
	"rule_code" text NOT NULL,
	"rule_version" integer NOT NULL,
	"system_type" "system_type" NOT NULL,
	"condition_expr" text NOT NULL,
	"condition_ast" jsonb,
	"quantity_formula" text NOT NULL,
	"quantity_ast" jsonb,
	"output_material_code" text NOT NULL,
	"standard_reference" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_rules_code_version_uq" UNIQUE("rule_code","rule_version")
);
--> statement-breakpoint
CREATE TABLE "install_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"rate_code" text NOT NULL,
	"description" text NOT NULL,
	"system_type" "system_type" NOT NULL,
	"linked_material" text,
	"rate" numeric(14, 2) NOT NULL,
	"unit" "install_rate_unit" NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "makes" (
	"make_code" text PRIMARY KEY NOT NULL,
	"material_code" text NOT NULL,
	"brand_name" text NOT NULL,
	"tier" "make_tier" NOT NULL,
	"approval_status" "approval_status" NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "margin_matrix" (
	"tier" integer PRIMARY KEY NOT NULL,
	"tier_label" text NOT NULL,
	"target_margin_pct" numeric(5, 2) NOT NULL,
	"floor_margin_pct" numeric(5, 2) NOT NULL,
	"discount_authority" "discount_authority" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "material_specs" (
	"material_code" text PRIMARY KEY NOT NULL,
	"applicable_standard" "applicable_standard",
	"rating" text,
	"size" text,
	"certifications" text[] DEFAULT '{}'::text[] NOT NULL,
	"compliance_notes" text
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"material_code" text PRIMARY KEY NOT NULL,
	"material_name" text NOT NULL,
	"system_type" "system_type" NOT NULL,
	"category" "material_category" NOT NULL,
	"unit_of_measure" "unit_of_measure" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source_provenance" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"price_id" text PRIMARY KEY NOT NULL,
	"material_code" text NOT NULL,
	"make_code" text NOT NULL,
	"buying_rate" numeric(14, 2) NOT NULL,
	"selling_rate" numeric(14, 2) NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"name" text NOT NULL,
	"year" integer NOT NULL,
	"value" integer NOT NULL,
	CONSTRAINT "sequences_name_year_pk" PRIMARY KEY("name","year")
);
--> statement-breakpoint
CREATE TABLE "enquiries" (
	"enquiry_id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"project_name" text NOT NULL,
	"building_type" "building_type" NOT NULL,
	"floors_above" integer NOT NULL,
	"floor_area_sqm" numeric(12, 2) NOT NULL,
	"systems_required" text[] NOT NULL,
	"make_preference" "make_preference" NOT NULL,
	"applicable_standard" "applicable_standard" NOT NULL,
	"project_tier" integer NOT NULL,
	"client_email" text,
	"client_phone" text,
	"notes" text,
	"source" "enquiry_source" NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"chat_session_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"estimate_version_id" text NOT NULL,
	"line_uid" text NOT NULL,
	"system_type" "system_type" NOT NULL,
	"section_order" integer NOT NULL,
	"line_order" integer NOT NULL,
	"material_code" text NOT NULL,
	"description" text NOT NULL,
	"make_code" text,
	"brand_name" text,
	"qty" numeric(12, 3) NOT NULL,
	"unit" "unit_of_measure" NOT NULL,
	"supply_rate" numeric(14, 2) NOT NULL,
	"install_rate" numeric(14, 2) NOT NULL,
	"sitc_rate" numeric(14, 2) NOT NULL,
	"supply_amount" numeric(14, 2) NOT NULL,
	"install_amount" numeric(14, 2) NOT NULL,
	"line_amount" numeric(14, 2) NOT NULL,
	"source" "line_source" NOT NULL,
	"rule_code" text,
	"price_id" text,
	"install_rate_code" text,
	"install_rate_unit" "install_rate_unit",
	"note" text,
	"edit_reason" text
);
--> statement-breakpoint
CREATE TABLE "estimate_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"estimate_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"state" "version_state" NOT NULL,
	"based_on_version" integer,
	"generation_snapshot" jsonb,
	"total_supply" numeric(14, 2) NOT NULL,
	"total_install" numeric(14, 2) NOT NULL,
	"total_sitc" numeric(14, 2) NOT NULL,
	"blended_ratio" numeric(8, 4),
	"margin_pct" numeric(6, 2),
	"gst_amount" numeric(14, 2) NOT NULL,
	"grand_total" numeric(14, 2) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	CONSTRAINT "estimate_versions_estimate_version_uq" UNIQUE("estimate_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"estimate_id" text PRIMARY KEY NOT NULL,
	"enquiry_id" text NOT NULL,
	"status" "estimate_status" NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"sitc_status" "sitc_status",
	"margin_status" "margin_status",
	"required_authority" "discount_authority",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" "audit_event_type" NOT NULL,
	"estimate_id" text,
	"enquiry_id" text,
	"version" integer,
	"actor" text NOT NULL,
	"actor_role" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" text PRIMARY KEY NOT NULL,
	"estimate_id" text NOT NULL,
	"document_ids" text[] NOT NULL,
	"channel" "dispatch_channel" NOT NULL,
	"recipient" text NOT NULL,
	"provider" text NOT NULL,
	"status" "dispatch_status" NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generated_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"estimate_version_id" text NOT NULL,
	"format" text DEFAULT 'A' NOT NULL,
	"kind" "document_kind" NOT NULL,
	"storage_uri" text NOT NULL,
	"sha256" text NOT NULL,
	"generated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_document_id" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"cost_usd" numeric(10, 6),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"source_document_id" text NOT NULL,
	"chunk_kind" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"storage_uri" text NOT NULL,
	"doc_type" text NOT NULL,
	"file_ref" text,
	"revision" text,
	"doc_date" timestamp with time zone,
	"source_entity" text,
	"page_count" integer,
	"status" text DEFAULT 'REGISTERED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staged_records" (
	"id" text PRIMARY KEY NOT NULL,
	"extraction_run_id" text NOT NULL,
	"target_master" text NOT NULL,
	"proposed" jsonb NOT NULL,
	"confidence" numeric(4, 3),
	"dedup_candidate_code" text,
	"source_locator" jsonb,
	"status" "staged_record_status" DEFAULT 'PROPOSED' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"lane" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"slot_state" jsonb NOT NULL,
	"enquiry_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"lane" text NOT NULL,
	"model" text NOT NULL,
	"intent" text,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"firebase_uid" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "design_rules" ADD CONSTRAINT "design_rules_output_material_code_materials_material_code_fk" FOREIGN KEY ("output_material_code") REFERENCES "public"."materials"("material_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "install_rates" ADD CONSTRAINT "install_rates_linked_material_materials_material_code_fk" FOREIGN KEY ("linked_material") REFERENCES "public"."materials"("material_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "makes" ADD CONSTRAINT "makes_material_code_materials_material_code_fk" FOREIGN KEY ("material_code") REFERENCES "public"."materials"("material_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_specs" ADD CONSTRAINT "material_specs_material_code_materials_material_code_fk" FOREIGN KEY ("material_code") REFERENCES "public"."materials"("material_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_material_code_materials_material_code_fk" FOREIGN KEY ("material_code") REFERENCES "public"."materials"("material_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_make_code_makes_make_code_fk" FOREIGN KEY ("make_code") REFERENCES "public"."makes"("make_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_estimate_version_id_estimate_versions_id_fk" FOREIGN KEY ("estimate_version_id") REFERENCES "public"."estimate_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_versions" ADD CONSTRAINT "estimate_versions_estimate_id_estimates_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("estimate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_enquiry_id_enquiries_enquiry_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("enquiry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_estimate_id_estimates_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("estimate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_estimate_version_id_estimate_versions_id_fk" FOREIGN KEY ("estimate_version_id") REFERENCES "public"."estimate_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_records" ADD CONSTRAINT "staged_records_extraction_run_id_extraction_runs_id_fk" FOREIGN KEY ("extraction_run_id") REFERENCES "public"."extraction_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_firebase_uid_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("firebase_uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_estimate_id_id_idx" ON "audit_events" USING btree ("estimate_id","id");