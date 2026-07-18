/**
 * @pebble/db — Drizzle schema, dual-driver client (node-postgres / PGlite),
 * migrations, repositories and seed for Pebble Module 02.
 *
 * Local dev and tests run entirely on PGlite with zero cloud credentials;
 * production points DATABASE_URL at Cloud SQL Postgres 16.
 */
export * from "./client";
export { newUlid } from "./ids";
export { migrateDb } from "./migrate";
export * as schema from "./schema";
export * from "./repositories";
export { seedDatabase } from "./seed";
