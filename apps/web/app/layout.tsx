import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

export const metadata: Metadata = {
  title: "Pebble — Estimate Crafting Space | Greenberg Engineering",
  description:
    "Fire-safety BOQ & estimate platform by Greenberg Engineering — agentic intake, deterministic pricing, audited dispatch.",
  metadataBase: new URL("https://pebble-web-4xnkcvcksa-el.a.run.app"),
  openGraph: {
    title: "Pebble — Estimate Crafting Space | Greenberg Engineering",
    description:
      "Fire-safety BOQ & estimate platform by Greenberg Engineering — agentic intake, deterministic pricing, audited dispatch.",
    images: ["/brand/wordmark.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Pebble — Estimate Crafting Space | Greenberg Engineering",
    description:
      "Fire-safety BOQ & estimate platform by Greenberg Engineering — agentic intake, deterministic pricing, audited dispatch.",
    images: ["/brand/wordmark.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} font-sans`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
