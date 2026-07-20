import { deleteMemoryFile, getMemoryFile, listMemoryFiles } from "@pebble/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc";

/**
 * Memory inspection router (Chat overhaul WP9). The typed control-plane behind
 * the /settings/memory page: list the signed-in user's memory files, view one's
 * content, and delete one.
 *
 * OWNER SCOPING (security): every procedure passes `ctx.user.firebaseUid` into
 * the memory repo, whose reads/writes are keyed by (user_id, path). A path that
 * belongs to another user (or does not exist) simply matches zero rows — `get`
 * surfaces that as NOT_FOUND, `delete` as `{ deleted: false }` — so a user can
 * only ever see or remove their OWN memory, admins included. The agent writes
 * these files through the same owner-bound store; this router is the read/prune
 * side of the same key space.
 */

const pathInput = z.object({ path: z.string().min(1) });

export const memoryRouter = router({
  /** The signed-in user's memory files (path, size, updated), path-ascending. No content — keep the list light. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await listMemoryFiles(ctx.db, ctx.user.firebaseUid);
    return rows.map((r) => ({ path: r.path, sizeBytes: r.sizeBytes, updatedAt: r.updatedAt }));
  }),

  /** One memory file's full content by path — owner-scoped; NOT_FOUND for a missing/foreign path. */
  get: protectedProcedure.input(pathInput).query(async ({ ctx, input }) => {
    const row = await getMemoryFile(ctx.db, { userId: ctx.user.firebaseUid, path: input.path });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Memory file not found." });
    return { path: row.path, content: row.content, sizeBytes: row.sizeBytes, updatedAt: row.updatedAt };
  }),

  /** Delete one memory file by path — owner-scoped; a no-op (`deleted:false`) on a missing/foreign path. */
  delete: protectedProcedure.input(pathInput).mutation(async ({ ctx, input }) => {
    const deleted = await deleteMemoryFile(ctx.db, { userId: ctx.user.firebaseUid, path: input.path });
    return { deleted };
  }),
});
