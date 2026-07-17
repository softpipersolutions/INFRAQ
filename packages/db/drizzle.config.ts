import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration for @pebble/db.
 * `pnpm db:generate` emits SQL migrations into ./drizzle; the generated
 * 0000_*.sql is then hand-extended with extensions, triggers and exclusion
 * constraints that Drizzle cannot express (see drizzle/0000_*.sql).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
});
