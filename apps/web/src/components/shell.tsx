"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { trpc } from "@/trpc/react";
import { Badge } from "./ui";

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

async function signOut(): Promise<void> {
  await fetch("/api/auth/session", { method: "DELETE" });
  window.location.href = "/login";
}

/** Sidebar footer: dev-admin badge in dev mode, account + sign-out in firebase mode. */
function SessionFooter() {
  const me = trpc.users.me.useQuery();
  if (!me.data) return null;

  if (me.data.authMode !== "firebase") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span>Dev mode · PGlite</span>
        <Badge tone="amber">dev admin</Badge>
      </div>
    );
  }

  if (!me.data.user) {
    return (
      <Link href="/login" className="hover:text-[var(--pebble-ink)]">
        Not signed in — sign in
      </Link>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="truncate" title={me.data.user.email}>
        {me.data.user.email}
      </div>
      <div className="flex items-center justify-between gap-2">
        <Badge tone={me.data.user.role === "admin" ? "red" : me.data.user.role === "approver" ? "green" : "blue"}>
          {me.data.user.role}
        </Badge>
        <button type="button" onClick={signOut} className="hover:text-[var(--pebble-ink)]">
          Sign out
        </button>
      </div>
    </div>
  );
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
          <SessionFooter />
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
