"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/enquiries/new", label: "New Enquiry" },
  { href: "/admin", label: "Masters" },
  { href: "/chat", label: "Chat" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-[var(--pebble-border)] bg-white md:flex">
        <div className="border-b border-[var(--pebble-border)] px-5 py-4">
          <div className="text-sm font-semibold tracking-tight">Pebble</div>
          <div className="text-xs text-[var(--pebble-muted)]">Estimate Crafting Space</div>
          <div className="mt-1 text-[10px] uppercase tracking-wide text-[var(--pebble-muted)]">
            Greenberg Enterprises
          </div>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-md px-3 py-2 text-sm font-medium transition ${
                isActive(pathname, item.href)
                  ? "bg-[var(--pebble-accent)] text-white"
                  : "text-[var(--pebble-ink)] hover:bg-slate-50"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-[var(--pebble-border)] px-5 py-3 text-xs text-[var(--pebble-muted)]">
          Dev mode · PGlite
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--pebble-border)] bg-white px-5 py-3 md:hidden">
          <span className="text-sm font-semibold">Pebble</span>
          <nav className="flex gap-3 text-sm">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="text-[var(--pebble-muted)]">
                {item.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-5 py-6">{children}</main>
      </div>
    </div>
  );
}
