/**
 * Bootstrap for the `eval:chat` script: registers `server-only-hook.mjs` as a
 * Node module-customization hook (`node:module#register`) BEFORE `tsx/esm`'s
 * own loader takes over, so every subsequent `import "server-only"` in
 * `src/server/*` resolves to the local stub instead of failing. Loaded via
 * `node --import ./scripts/server-only-loader.mjs --import tsx/esm ...` in
 * the `eval:chat` package.json script — see `server-only-stub.mjs` for why
 * this is needed at all.
 */
import { register } from "node:module";

register("./server-only-hook.mjs", import.meta.url);
