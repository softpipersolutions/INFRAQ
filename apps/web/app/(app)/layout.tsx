import type { ReactNode } from "react";
import { Shell } from "@/components/shell";
import { TRPCProvider } from "@/trpc/provider";

/** Authenticated app chrome: tRPC provider + the signed-in Shell (sidebar/nav). */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <TRPCProvider>
      <Shell>{children}</Shell>
    </TRPCProvider>
  );
}
