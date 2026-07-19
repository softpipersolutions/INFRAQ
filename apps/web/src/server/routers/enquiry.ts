import { getEnquiry } from "@pebble/db";
import { enquiryInputSchema } from "@pebble/shared";
import { z } from "zod";
import { createEnquiryAndGenerate } from "../generate";
import { listEnquiries } from "../queries";
import { protectedProcedure, router } from "../trpc";

export const enquiryRouter = router({
  /**
   * Create an A.08 enquiry and immediately run deterministic generation,
   * persisting a LOCKED v1 draft. Returns both ids so the UI can redirect to
   * the draft grid.
   */
  create: protectedProcedure.input(enquiryInputSchema).mutation(async ({ ctx, input }) => {
    return createEnquiryAndGenerate(ctx.db, input, ctx.user.firebaseUid, ctx.user.role);
  }),

  get: protectedProcedure.input(z.object({ enquiryId: z.string() })).query(async ({ ctx, input }) => {
    return getEnquiry(ctx.db, input.enquiryId);
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    return listEnquiries(ctx.db);
  }),
});
