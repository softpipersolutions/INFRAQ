import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Web tests exercise the tRPC routers directly against an in-memory PGlite
 * database. File parallelism is disabled so the single-threaded WASM Postgres
 * instances don't contend (mirrors packages/db and apps/worker).
 *
 * The "server-only" marker package throws outside a React Server context, so
 * it is aliased to an empty stub for tests.
 */
export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
