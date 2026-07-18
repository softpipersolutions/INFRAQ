import { getUser, schema, upsertUser } from "@pebble/db";
import { USER_ROLES } from "@pebble/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, roleProcedure, router } from "../trpc";

export const usersRouter = router({
  /**
   * Current session for the shell — public because it must answer "signed out"
   * on /login rather than error. Also reports the auth mode so the UI can
   * render the right badge (dev admin vs Google account).
   */
  me: publicProcedure.query(({ ctx }) => ({
    user: ctx.user,
    authMode: (process.env.AUTH_MODE ?? "dev") === "firebase" ? ("firebase" as const) : ("dev" as const),
  })),

  /** All user rows (small table; sorted in JS like the other list queries). */
  list: roleProcedure("admin").query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(schema.users);
    return rows
      .map((r) => ({
        firebaseUid: r.firebaseUid,
        email: r.email,
        displayName: r.displayName,
        role: r.role,
        active: r.active,
        createdAt: r.createdAt.toISOString(),
      }))
      .sort((a, b) => a.email.localeCompare(b.email));
  }),

  setRole: roleProcedure("admin")
    .input(z.object({ firebaseUid: z.string().min(1), role: z.enum(USER_ROLES) }))
    .mutation(async ({ ctx, input }) => {
      const user = await getUser(ctx.db, input.firebaseUid);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      await upsertUser(ctx.db, { ...user, role: input.role });
      return { ok: true };
    }),
});
