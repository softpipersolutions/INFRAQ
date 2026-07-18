import { defineConfig } from "vitest/config";

/**
 * Each worker test spins up its own in-memory PGlite database (via
 * `@pebble/db`'s `createDb({ pglite: true, pgliteDir: "memory://" })`). File
 * parallelism is disabled so the single-threaded WASM Postgres instances don't
 * contend, mirroring `packages/db/vitest.config.ts` and keeping failures
 * deterministic.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
