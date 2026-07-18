import "server-only";

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Db, AppUser } from "@pebble/db";

/** tRPC request context — the bootstrapped db and the current user. */
export interface Ctx {
  db: Db;
  user: AppUser;
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

/** Require one of the given roles (admin passes everything). */
export function requireRole(...roles: AppUser["role"][]) {
  return t.procedure.use(({ ctx, next }) => {
    if (ctx.user.role !== "admin" && !roles.includes(ctx.user.role)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Requires role: ${roles.join(" or ")}`,
      });
    }
    return next({ ctx });
  });
}
