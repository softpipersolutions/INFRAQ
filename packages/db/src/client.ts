import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import pg from "pg";
import * as schema from "./schema";

/** The full Drizzle schema object (tables + pg enums). */
export type DbSchema = typeof schema;

/**
 * Driver-agnostic database type. Both NodePgDatabase and PgliteDatabase (and
 * the PgTransaction objects their `.transaction()` callbacks receive) satisfy
 * it, so every repository function accepts either a database or a transaction
 * from either driver.
 */
export type Db = PgDatabase<PgQueryResultHKT, DbSchema>;

/** Handle returned by createDb — discriminated so migrateDb can pick the right migrator. */
export type DbHandle =
  | { db: NodePgDatabase<DbSchema>; kind: "pg"; close(): Promise<void> }
  | { db: PgliteDatabase<DbSchema>; kind: "pglite"; close(): Promise<void> };

export interface CreateDbOptions {
  /** Force the embedded PGlite driver even when DATABASE_URL is set. */
  pglite?: boolean;
  /**
   * PGlite data directory. Defaults to $PGLITE_DIR, then "memory://"
   * (ephemeral in-memory database — ideal for tests).
   */
  pgliteDir?: string;
}

/**
 * Create a database connection.
 *
 * - When DATABASE_URL is set (and opts.pglite !== true): node-postgres Pool.
 * - Otherwise: embedded PGlite with the vector, pg_trgm and btree_gist
 *   extensions loaded (they are required by the migrations).
 *
 * Always `await handle.close()` when done.
 */
export async function createDb(opts: CreateDbOptions = {}): Promise<DbHandle> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl && opts.pglite !== true) {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const db = drizzleNodePg(pool, { schema });
    return {
      db,
      kind: "pg",
      close: async () => {
        await pool.end();
      },
    };
  }

  const dir = opts.pgliteDir ?? process.env.PGLITE_DIR ?? "memory://";
  const client = new PGlite(dir, { extensions: { vector, pg_trgm, btree_gist } });
  await client.waitReady;
  const db = drizzlePglite(client, { schema });
  return {
    db,
    kind: "pglite",
    close: async () => {
      await client.close();
    },
  };
}
