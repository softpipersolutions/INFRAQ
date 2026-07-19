import "server-only";

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createDb,
  ensureDevUser,
  listMaterials,
  seedDatabase,
  type Db,
  type DbHandle,
} from "@pebble/db";

/**
 * Lazily-created database singleton for the web app.
 *
 * On first access we create the connection (Cloud SQL via DATABASE_URL when set,
 * otherwise embedded PGlite at PGLITE_DIR — zero cloud credentials in dev), run
 * the migrations once, and seed the starter masters + dev admin when the
 * database is empty (or when SEED_ON_BOOT=1). The promise is cached so the
 * bootstrap runs exactly once even under concurrent first requests.
 *
 * We apply the migration SQL directly (rather than the db package's migrateDb)
 * because that helper resolves its bundled drizzle/*.sql relative to its own
 * module URL, which does not survive Next's server bundling. Here we locate the
 * migrations dir from the installed package (and a couple of stable fallbacks)
 * so it works both in `next dev` and a production `next start`.
 *
 * Node runtime only — never import this from a client component.
 */

export interface DbBundle {
  handle: DbHandle;
  db: Db;
}

let bootstrapPromise: Promise<DbBundle> | null = null;

/** Find the drizzle migrations directory across dev/bundled/prod layouts. */
function findMigrationsDir(): string {
  const candidates: string[] = [];

  try {
    const require = createRequire(import.meta.url);
    const dbEntry = require.resolve("@pebble/db");
    candidates.push(join(dirname(dbEntry), "..", "drizzle"));
  } catch {
    // resolution not available in this context — fall through to path guesses.
  }

  const cwd = process.cwd();
  candidates.push(join(cwd, "..", "..", "packages", "db", "drizzle"));
  candidates.push(join(cwd, "node_modules", "@pebble", "db", "drizzle"));

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(
    `Could not locate @pebble/db migrations. Tried:\n${candidates.map((c) => `  - ${c}`).join("\n")}`,
  );
}

/** Apply the SQL migrations in filename order (idempotent for re-runs). */
async function applyMigrations(handle: DbHandle): Promise<void> {
  const dir = findMigrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  await handle.exec(
    `CREATE TABLE IF NOT EXISTS __pebble_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     );`,
  );

  for (const file of files) {
    const contents = await readFile(join(dir, file), "utf8");
    try {
      await handle.exec(contents);
    } catch (err) {
      // A persistent PGLITE_DIR / Cloud SQL may already have these objects; the
      // migration is a no-op then. Only "already exists" is safe to ignore.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists|duplicate/i.test(message)) throw err;
    }
    await handle
      .exec(`INSERT INTO __pebble_migrations (name) VALUES ('${file}') ON CONFLICT DO NOTHING;`)
      .catch(() => undefined);
  }
}

async function bootstrap(): Promise<DbBundle> {
  const handle = await createDb();
  const db = handle.db as unknown as Db;

  await applyMigrations(handle);

  const empty = (await listMaterials(db)).length === 0;
  if (empty && process.env.SEED_ON_BOOT !== "0") {
    // seedDatabase assumes a fresh masters set; only run it when empty.
    await seedDatabase(db);
  }

  // Guarantee the dev admin exists so every screen has an actor — but only
  // outside firebase mode: production's users table should hold real accounts
  // only (the dev row is inert there, but it muddies /admin/users and the
  // first-admin bootstrap check).
  if ((process.env.AUTH_MODE ?? "dev") !== "firebase") {
    await ensureDevUser(db);
  }

  return { handle, db };
}

/** Get the shared database bundle, bootstrapping (migrate + seed) once. */
export function getDb(): Promise<DbBundle> {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrap().catch((err) => {
      console.error("[pebble] db bootstrap failed:", err instanceof Error ? err.stack : err);
      // Reset so a transient failure can be retried on the next request.
      bootstrapPromise = null;
      throw err;
    });
  }
  return bootstrapPromise;
}
