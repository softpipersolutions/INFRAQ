import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Shell } from "@/components/shell";
import { TRPCProvider } from "@/trpc/provider";

export const metadata: Metadata = {
  title: "Pebble · Estimate Crafting Space",
  description: "Fire-safety BOQ / estimate crafting for Greenberg Enterprises (Pebble Module 02).",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <TRPCProvider>
          <Shell>{children}</Shell>
        </TRPCProvider>
      </body>
    </html>
  );
}
