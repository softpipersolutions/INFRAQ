import { integer, jsonb, numeric, pgTable, text, timestamp, vector } from "drizzle-orm/pg-core";
import { stagedRecordStatusEnum } from "./enums";
import { materials } from "./masters";

/**
 * Ingestion pipeline: registered source documents → LLM extraction runs →
 * staged records awaiting human review → RAG chunks for retrieval.
 *
 * rag_chunks additionally gets (via hand-written migration SQL, since drizzle
 * cannot express them): a GENERATED tsvector column `content_tsv` with a GIN
 * index, and an HNSW index on `embedding` (vector_cosine_ops).
 */

/** A registered historical document (proposal PDF, DSR Excel…). */
export const sourceDocuments = pgTable("source_documents", {
  id: text("id").primaryKey(), // ULID
  filename: text("filename").notNull(),
  storageUri: text("storage_uri").notNull(),
  docType: text("doc_type").notNull(),
  fileRef: text("file_ref"),
  revision: text("revision"),
  docDate: timestamp("doc_date", { withTimezone: true }),
  sourceEntity: text("source_entity"),
  pageCount: integer("page_count"),
  status: text("status").notNull().default("REGISTERED"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One LLM extraction pass over a source document. */
export const extractionRuns = pgTable("extraction_runs", {
  id: text("id").primaryKey(), // ULID
  sourceDocumentId: text("source_document_id")
    .notNull()
    .references(() => sourceDocuments.id),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull(),
});

/** One proposed master row extracted by an LLM, pending review. */
export const stagedRecords = pgTable("staged_records", {
  id: text("id").primaryKey(), // ULID
  extractionRunId: text("extraction_run_id")
    .notNull()
    .references(() => extractionRuns.id),
  /** Which master the proposal targets, e.g. "materials", "prices". */
  targetMaster: text("target_master").notNull(),
  proposed: jsonb("proposed").$type<Record<string, unknown>>().notNull(),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  dedupCandidateCode: text("dedup_candidate_code"),
  /** Where in the source document the proposal came from (page, bbox…). */
  sourceLocator: jsonb("source_locator").$type<Record<string, unknown>>(),
  status: stagedRecordStatusEnum("status").notNull().default("PROPOSED"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Retrieval chunks with pgvector embeddings (768-dim). */
export const ragChunks = pgTable("rag_chunks", {
  id: text("id").primaryKey(), // ULID
  sourceDocumentId: text("source_document_id")
    .notNull()
    .references(() => sourceDocuments.id),
  chunkKind: text("chunk_kind").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 768 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-material name embedding (768-dim) for dedup / fuzzy material matching at
 * commit time — kept 1:1 with materials and dropped when a material is deleted.
 * The vector index is added by hand-written migration SQL (drizzle cannot
 * express it), mirroring rag_chunks.
 */
export const materialNameEmbeddings = pgTable("material_name_embeddings", {
  materialCode: text("material_code")
    .primaryKey()
    .references(() => materials.materialCode, { onDelete: "cascade" }),
  embedding: vector("embedding", { dimensions: 768 }).notNull(),
  model: text("model").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
