import "server-only";

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Db, AppUser } from "@pebble/db";

/**
 * tRPC request context — the bootstrapped db and the current user. `user` is
 * null only in firebase mode with no valid session; dev mode always resolves
 * the dev admin.
 */
export interface Ctx {
  db: Db;
  user: AppUser | null;
}

const t = initTRPC.context<Ctx>().create({
  transformer: superjson,
  errorFormatter({ shape }) {
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
export const middleware = t.middleware;

/**
 * Require a signed-in user (narrows ctx.user to non-null). In dev mode the
 * dev admin always satisfies this.
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** Require one of the given roles (admin passes everything). */
export function roleProcedure(...roles: AppUser["role"][]) {
  return protectedProcedure.use(({ ctx, next }) => {
    if (ctx.user.role !== "admin" && !roles.includes(ctx.user.role)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Requires role: ${roles.join(" or ")}`,
      });
    }
    return next({ ctx });
  });
}
