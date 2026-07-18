import { createDb } from "../client";
import { migrateDb } from "../migrate";
import { seedDatabase } from "./index";

/**
 * CLI: `pnpm db:seed`. Migrates (idempotent) then seeds the starter masters.
 * Runs against DATABASE_URL when set, otherwise the PGlite dev database
 * (PGLITE_DIR, default .data/pglite via createDb).
 */
async function main(): Promise<void> {
  const handle = await createDb();
  try {
    await migrateDb(handle);
    const result = await seedDatabase(handle.db);
    console.log(`[seed] done on ${handle.kind}:`);
    console.log(
      `  ${result.materials} materials · ${result.makes} makes · ${result.prices} prices · ` +
        `${result.installRates} install rates · ${result.rules} rules · ${result.marginRows} margin tiers`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exitCode = 1;
});
