"use client";

import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@/server/routers/_app";

/** Typed tRPC React hooks — the only server surface a client component touches. */
export const trpc = createTRPCReact<AppRouter>();
