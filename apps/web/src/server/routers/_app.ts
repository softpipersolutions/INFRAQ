import { router } from "../trpc";
import { chatRouter } from "./chat";
import { dashboardRouter } from "./dashboard";
import { enquiryRouter } from "./enquiry";
import { estimateRouter } from "./estimate";
import { ingestionRouter } from "./ingestion";
import { mastersRouter } from "./masters";
import { memoryRouter } from "./memory";
import { usersRouter } from "./users";

export const appRouter = router({
  chat: chatRouter,
  dashboard: dashboardRouter,
  enquiry: enquiryRouter,
  estimate: estimateRouter,
  ingestion: ingestionRouter,
  masters: mastersRouter,
  memory: memoryRouter,
  users: usersRouter,
});

export type AppRouter = typeof appRouter;
