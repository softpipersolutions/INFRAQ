/**
 * Stub for the "server-only" marker package.
 *
 * "server-only" is not an installed npm dependency anywhere in this monorepo
 * — Next.js's build-time bundler is the only consumer that actually resolves
 * it (via its own webpack "browser" condition trickery), and vitest instead
 * aliases the bare specifier to `apps/web/test/stubs/server-only.ts` (see
 * `apps/web/vitest.config.ts`). Several `src/server/*` modules the eval
 * harness imports read-only (`chat-agent.ts`, `digest-cache.ts`,
 * `ai-services.ts`, `db.ts`) start with `import "server-only";`, so running
 * the eval scripts under plain `tsx`/`node` (no Next.js, no vitest) needs the
 * same kind of stand-in. See `server-only-loader.mjs` for the resolve hook
 * that redirects the bare specifier here.
 */
export {};
