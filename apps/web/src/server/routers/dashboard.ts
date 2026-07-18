import { dashboardStats, listEstimates } from "../queries";
import { protectedProcedure, router } from "../trpc";

export const dashboardRouter = router({
  stats: protectedProcedure.query(async ({ ctx }) => {
    return dashboardStats(ctx.db);
  }),

  estimates: protectedProcedure.query(async ({ ctx }) => {
    return listEstimates(ctx.db);
  }),
});
