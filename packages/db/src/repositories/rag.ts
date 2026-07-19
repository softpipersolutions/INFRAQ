import { eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client";
import { newUlid } from "../ids";
import { materialNameEmbeddings, ragChunks, sourceDocuments } from "../schema";

/**
 * Retrieval-augmented-generation repository — the chunk store plus the hybrid
 * (keyword + vector) search and the material-dedup helpers used at commit time.
 *
 * All functions take `db: Db` first so they compose inside a `db.transaction`.
 * pgvector values are bound in raw SQL as the pgvector text literal `[a,b,…]`
 * cast to `vector(768)` — the one format that works identically on node-postgres
 * and the PGlite dev/test driver (both load the `vector` extension). Drizzle's
 * `vector` column type handles number[] ⇆ array on plain insert/select, so only
 * the distance/search queries need the literal.
 */

/** pgvector text literal for a 768-dim embedding: `[0.1,0.2,…]`. */
function vectorLiteral(nums: number[]): string {
  return `[${nums.join(",")}]`;
}

export interface DocChunkInput {
  chunkKind: string;
  content: string;
  embedding: number[] | null;
  metadata: Record<string, unknown>;
}

/**
 * Replace ALL chunks for a source document with a fresh set (delete-then-insert
 * in one transaction). `content_tsv` is a GENERATED column — never written here;
 * Postgres derives it from `content` on insert.
 */
export async function replaceDocChunks(
  db: Db,
  sourceDocumentId: string,
  chunks: DocChunkInput[],
): Promise<number> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.delete(ragChunks).where(eq(ragChunks.sourceDocumentId, sourceDocumentId));
    if (chunks.length === 0) return 0;
    await tx.insert(ragChunks).values(
      chunks.map((c) => ({
        id: newUlid(),
        sourceDocumentId,
        chunkKind: c.chunkKind,
        content: c.content,
        embedding: c.embedding ?? null,
        metadata: c.metadata ?? null,
      })),
    );
    return chunks.length;
  });
}

export interface HybridFilters {
  chunkKind?: string[];
  systems?: string[];
  docDateFrom?: string;
  docDateTo?: string;
}

export interface HybridSearchArgs {
  queryText: string;
  queryEmbedding: number[] | null;
  k?: number;
  filters?: HybridFilters;
}

export interface RagHit {
  id: string;
  sourceDocumentId: string;
  filename: string;
  chunkKind: string;
  content: string;
  metadata: Record<string, unknown> | null;
  score: number;
}

/** Extra WHERE predicates shared by both retrieval arms. */
function filterConds(filters?: HybridFilters): SQL[] {
  const conds: SQL[] = [];
  if (filters?.chunkKind && filters.chunkKind.length > 0) {
    conds.push(
      sql`chunk_kind = ANY(ARRAY[${sql.join(
        filters.chunkKind.map((k) => sql`${k}`),
        sql`, `,
      )}]::text[])`,
    );
  }
  if (filters?.systems && filters.systems.length > 0) {
    conds.push(
      sql`(metadata -> 'systems') ?| ARRAY[${sql.join(
        filters.systems.map((s) => sql`${s}`),
        sql`, `,
      )}]::text[]`,
    );
  }
  if (filters?.docDateFrom) conds.push(sql`(metadata ->> 'docDateISO') >= ${filters.docDateFrom}`);
  if (filters?.docDateTo) conds.push(sql`(metadata ->> 'docDateISO') <= ${filters.docDateTo}`);
  return conds;
}

/**
 * Hybrid retrieval with Reciprocal Rank Fusion (k=60). Two arms — a tsvector
 * keyword arm (always) and a pgvector cosine arm (only when an embedding is
 * supplied) — each return their top 30; fused scores are 1/(60+rank) summed per
 * chunk id. Works with `queryEmbedding: null` (tsvector-only), which is the
 * PGlite/dev path.
 */
export async function hybridSearch(db: Db, args: HybridSearchArgs): Promise<RagHit[]> {
  const k = args.k ?? 12;
  const conds = filterConds(args.filters);
  const whereExtra: SQL = conds.length > 0 ? sql` AND ${sql.join(conds, sql` AND `)}` : sql``;

  const kwRes = (await db.execute(sql`
    SELECT id FROM rag_chunks
    WHERE content_tsv @@ plainto_tsquery('english', ${args.queryText})${whereExtra}
    ORDER BY ts_rank_cd(content_tsv, plainto_tsquery('english', ${args.queryText})) DESC
    LIMIT 30
  `)) as unknown as { rows: Array<{ id: string }> };

  let vecRows: Array<{ id: string }> = [];
  if (args.queryEmbedding) {
    const vecLit = vectorLiteral(args.queryEmbedding);
    const vecRes = (await db.execute(sql`
      SELECT id FROM rag_chunks
      WHERE embedding IS NOT NULL${whereExtra}
      ORDER BY embedding <=> ${vecLit}::vector(768)
      LIMIT 30
    `)) as unknown as { rows: Array<{ id: string }> };
    vecRows = vecRes.rows;
  }

  const scores = new Map<string, number>();
  kwRes.rows.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (60 + (i + 1))));
  vecRows.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (60 + (i + 1))));

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  if (ranked.length === 0) return [];

  const ids = ranked.map(([id]) => id);
  const details = await db
    .select({
      id: ragChunks.id,
      sourceDocumentId: ragChunks.sourceDocumentId,
      filename: sourceDocuments.filename,
      chunkKind: ragChunks.chunkKind,
      content: ragChunks.content,
      metadata: ragChunks.metadata,
    })
    .from(ragChunks)
    .innerJoin(sourceDocuments, eq(ragChunks.sourceDocumentId, sourceDocuments.id))
    .where(inArray(ragChunks.id, ids));
  const byId = new Map(details.map((d) => [d.id, d]));

  return ranked
    .filter(([id]) => byId.has(id))
    .map(([id, score]) => {
      const d = byId.get(id)!;
      return {
        id,
        sourceDocumentId: d.sourceDocumentId,
        filename: d.filename,
        chunkKind: d.chunkKind,
        content: d.content,
        metadata: d.metadata ?? null,
        score,
      };
    });
}

export interface TrgmCandidate {
  materialCode: string;
  materialName: string;
  similarity: number;
}

/**
 * pg_trgm fuzzy material-name candidates ordered by trigram similarity. Uses the
 * gin_trgm index on materials.material_name (0002). Safe to call in-transaction —
 * this is the commit-time dedup re-check.
 */
export async function trgmMaterialCandidates(
  db: Db,
  name: string,
  limit = 5,
): Promise<TrgmCandidate[]> {
  const res = (await db.execute(sql`
    SELECT material_code AS "materialCode",
           material_name AS "materialName",
           similarity(material_name, ${name}) AS similarity
    FROM materials
    WHERE similarity(material_name, ${name}) > 0
    ORDER BY similarity(material_name, ${name}) DESC
    LIMIT ${limit}
  `)) as unknown as {
    rows: Array<{ materialCode: string; materialName: string; similarity: number | string }>;
  };
  return res.rows.map((r) => ({
    materialCode: r.materialCode,
    materialName: r.materialName,
    similarity: Number(r.similarity),
  }));
}

export interface NearestMaterialName {
  materialCode: string;
  cosine: number;
}

/** Nearest material names by cosine distance over material_name_embeddings. */
export async function nearestMaterialNames(
  db: Db,
  embedding: number[],
  limit = 5,
): Promise<NearestMaterialName[]> {
  const vecLit = vectorLiteral(embedding);
  const res = (await db.execute(sql`
    SELECT material_code AS "materialCode",
           (embedding <=> ${vecLit}::vector(768)) AS cosine
    FROM material_name_embeddings
    ORDER BY embedding <=> ${vecLit}::vector(768)
    LIMIT ${limit}
  `)) as unknown as { rows: Array<{ materialCode: string; cosine: number | string }> };
  return res.rows.map((r) => ({ materialCode: r.materialCode, cosine: Number(r.cosine) }));
}

/** Insert or update the per-material name embedding (1:1 with materials). */
export async function upsertMaterialNameEmbedding(
  db: Db,
  materialCode: string,
  embedding: number[],
  model: string,
): Promise<void> {
  await db
    .insert(materialNameEmbeddings)
    .values({ materialCode, embedding, model })
    .onConflictDoUpdate({
      target: materialNameEmbeddings.materialCode,
      set: { embedding, model, updatedAt: new Date() },
    });
}
