import { router } from "../trpc";
import { dashboardRouter } from "./dashboard";
import { enquiryRouter } from "./enquiry";
import { estimateRouter } from "./estimate";
import { mastersRouter } from "./masters";

export const appRouter = router({
  dashboard: dashboardRouter,
  enquiry: enquiryRouter,
  estimate: estimateRouter,
  masters: mastersRouter,
});

export type AppRouter = typeof appRouter;
