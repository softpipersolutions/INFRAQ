import { defineConfig } from "vitest/config";

/**
 * Each test file spins up its own in-memory PGlite database. File parallelism
 * is disabled to keep the WASM Postgres instances from contending for the
 * single-threaded runtime, and to make failures deterministic.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
