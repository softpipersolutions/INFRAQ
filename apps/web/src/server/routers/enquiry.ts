import { createEnquiry, getEnquiry } from "@pebble/db";
import { enquiryInputSchema } from "@pebble/shared";
import { z } from "zod";
import { generateForEnquiry } from "../generate";
import { listEnquiries } from "../queries";
import { protectedProcedure, router } from "../trpc";

export const enquiryRouter = router({
  /**
   * Create an A.08 enquiry and immediately run deterministic generation,
   * persisting a LOCKED v1 draft. Returns both ids so the UI can redirect to
   * the draft grid.
   */
  create: protectedProcedure.input(enquiryInputSchema).mutation(async ({ ctx, input }) => {
    const enquiry = await createEnquiry(ctx.db, input, ctx.user.firebaseUid);
    const estimateId = await generateForEnquiry(
      ctx.db,
      enquiry.enquiryId,
      ctx.user.firebaseUid,
      ctx.user.role,
    );
    return { enquiryId: enquiry.enquiryId, estimateId };
  }),

  get: protectedProcedure.input(z.object({ enquiryId: z.string() })).query(async ({ ctx, input }) => {
    return getEnquiry(ctx.db, input.enquiryId);
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    return listEnquiries(ctx.db);
  }),
});
