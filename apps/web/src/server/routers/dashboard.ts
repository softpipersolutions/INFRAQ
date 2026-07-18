import { dashboardStats, listEstimates } from "../queries";
import { publicProcedure, router } from "../trpc";

export const dashboardRouter = router({
  stats: publicProcedure.query(async ({ ctx }) => {
    return dashboardStats(ctx.db);
  }),

  estimates: publicProcedure.query(async ({ ctx }) => {
    return listEstimates(ctx.db);
  }),
});
