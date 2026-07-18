import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createContext } from "@/server/context";
import { appRouter } from "@/server/routers/_app";

/** tRPC runs on the Node runtime (PGlite / pg / engines are node-only). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext,
    onError({ error, path }) {
      console.error(`[trpc] error on ${path ?? "<no-path>"}:`, error.message);
    },
  });
}

export { handler as GET, handler as POST };
