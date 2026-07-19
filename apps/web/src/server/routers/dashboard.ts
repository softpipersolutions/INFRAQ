import { schema } from "@pebble/db";
import { dashboardStats, listEstimates } from "../queries";
import { protectedProcedure, router } from "../trpc";

export const dashboardRouter = router({
  stats: protectedProcedure.query(async ({ ctx }) => {
    return dashboardStats(ctx.db);
  }),

  estimates: protectedProcedure.query(async ({ ctx }) => {
    return listEstimates(ctx.db);
  }),

  /**
   * LLM spend for the dashboard cost tile (spec §4.4 / "5 Chat + MCP" cost
   * dashboard): today + this calendar month, cost and call count, summed
   * from llm_calls. Small table — select-all + reduce in JS matches the
   * house style in queries.ts. Deliberately independent of the chat router
   * (owned by a parallel lane) so this tile works even before that lane
   * lands; the UI layers chat.costToday's daily budget on top when present.
   */
  llmCost: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(schema.llmCalls);
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let todayCostUsd = 0;
    let todayCalls = 0;
    let monthCostUsd = 0;
    let monthCalls = 0;

    for (const r of rows) {
      const cost = r.costUsd === null ? 0 : Number(r.costUsd);
      if (r.createdAt >= startOfMonth) {
        monthCostUsd += cost;
        monthCalls += 1;
      }
      if (r.createdAt >= startOfDay) {
        todayCostUsd += cost;
        todayCalls += 1;
      }
    }

    return {
      today: { costUsd: todayCostUsd, calls: todayCalls },
      month: { costUsd: monthCostUsd, calls: monthCalls },
    };
  }),
});
