import "server-only";

import { getCurrentUser } from "./auth";
import { getDb } from "./db";
import type { Ctx } from "./trpc";

/** Build the per-request tRPC context (shared db singleton + current user). */
export async function createContext(): Promise<Ctx> {
  const { db } = await getDb();
  const user = await getCurrentUser();
  return { db, user };
}
