import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "./client";

/**
 * Migration runner for @pebble/db.
 *
 * The generated Drizzle SQL (0000) plus the hand-written integrity layer (0001,
 * triggers + EXCLUDE constraints + retrieval indexes) are applied in filename
 * order and tracked in `__pebble_migrations`. We deliberately do not use
 * Drizzle's built-in migrator: each `.sql` file is a self-contained batch run
 * through the driver's multi-statement `exec`, which keeps plpgsql
 * dollar-quoted bodies intact and works the same on node-postgres and PGlite.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

interface RowsResult {
  rows: Array<{ name: string }>;
}

/** Apply all pending SQL migrations. Idempotent — safe to re-run. */
export async function migrateDb(handle: DbHandle): Promise<string[]> {
  await handle.exec(
    `CREATE TABLE IF NOT EXISTS __pebble_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     );`,
  );

  const result = (await handle.db.execute(
    sql`SELECT name FROM __pebble_migrations`,
  )) as unknown as RowsResult;
  const applied = new Set(result.rows.map((r) => r.name));

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const contents = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await handle.exec(contents);
    await handle.db.execute(sql`INSERT INTO __pebble_migrations (name) VALUES (${file})`);
    newlyApplied.push(file);
  }
  return newlyApplied;
}

async function main(): Promise<void> {
  const handle = await createDb();
  try {
    const applied = await migrateDb(handle);
    if (applied.length === 0) {
      console.log(`[migrate] up to date (${handle.kind})`);
    } else {
      console.log(`[migrate] applied ${applied.length} migration(s) on ${handle.kind}:`);
      for (const name of applied) console.log(`  + ${name}`);
    }
  } finally {
    await handle.close();
  }
}

// Run when invoked directly (`tsx src/migrate.ts`), not when imported by tests.
const entry = process.argv[1];
if (entry !== undefined && /migrate\.(ts|mts|js)$/.test(entry)) {
  main().catch((err) => {
    console.error("[migrate] failed:", err);
    process.exitCode = 1;
  });
}
