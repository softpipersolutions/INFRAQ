/**
 * Node module-customization "resolve" hook: redirects any `import
 * "server-only"` to the local no-op stub (`server-only-stub.mjs`) instead of
 * letting Node's default resolver fail on a package that was never installed
 * (see that file's header for why). Registered by `server-only-loader.mjs`
 * via `node:module`'s `register()`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STUB_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "server-only-stub.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
