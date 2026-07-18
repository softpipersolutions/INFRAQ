import type { NextConfig } from "next";

/**
 * Pebble Module 02 — @pebble/web.
 *
 * Workspace packages ship TypeScript source (exports "./src/index.ts"), so Next
 * must transpile them. The node-only libraries they reach for (PGlite, pg,
 * exceljs, Chromium via playwright-core) must stay external so they run only on
 * the server and are never bundled — PGlite in particular is an Emscripten wasm
 * module that must be require()d from node_modules (bundling it breaks its
 * URL-based file loading under Node's fs).
 *
 * Because @pebble/db is transpiled AND imports PGlite, `serverExternalPackages`
 * alone does not keep PGlite out of the bundle; the webpack externals below
 * force it (and its subpath extension imports) to be required at runtime.
 */
const NODE_ONLY_PACKAGES = [
  "@electric-sql/pglite",
  "pg",
  "exceljs",
  "playwright-core",
  // Lazy-loaded only when AUTH_MODE=firebase; external keeps it (and its gRPC
  // deps) out of the bundle so builds need no Firebase env at all.
  "firebase-admin",
  // Reached via @pebble/worker's storage adapter (GCS) and the HTTP worker
  // client's OIDC minting — both lazy, both server-only, both heavy.
  "@google-cloud/storage",
  "google-auth-library",
];

const nextConfig: NextConfig = {
  // NOTE: no `output: "standalone"` — the custom `externals` function below
  // defeats Next's output file tracing (the traced bundle shipped an empty
  // node_modules), so the Cloud Run image (infra/Dockerfile.web) runs a
  // prod-installed workspace with `next start` instead.
  transpilePackages: [
    "@pebble/shared",
    "@pebble/db",
    "@pebble/engines",
    "@pebble/ai",
    "@pebble/documents",
    "@pebble/dispatch",
    "@pebble/expr",
    "@pebble/worker",
  ],
  serverExternalPackages: NODE_ONLY_PACKAGES,
  webpack: (config, { isServer }) => {
    if (isServer) {
      const previous = config.externals;
      const existing = Array.isArray(previous) ? previous : previous ? [previous] : [];
      config.externals = [
        ...existing,
        (
          ctx: { request?: string },
          callback: (err?: unknown, result?: string) => void,
        ) => {
          const request = ctx.request;
          if (
            request &&
            NODE_ONLY_PACKAGES.some((pkg) => request === pkg || request.startsWith(`${pkg}/`))
          ) {
            return callback(undefined, `commonjs ${request}`);
          }
          return callback();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
