"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { trpc } from "@/trpc/react";
import { Badge } from "./ui";

interface NavItem {
  href: string;
  label: string;
}

/** Visible to every signed-in role. Chat-first order (Phase C.5 chat overhaul WP3). */
const BASE_NAV: NavItem[] = [
  { href: "/chat", label: "Chat" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/enquiries/new", label: "New Enquiry" },
  { href: "/history", label: "History" },
  { href: "/admin", label: "Masters" },
];

/** Admin-only — appended when users.me resolves the current user's role to admin. */
const ADMIN_NAV: NavItem[] = [{ href: "/admin/ingestion", label: "Ingestion" }];

function isActive(pathname: string, href: string): boolean {
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
        <Badge tone="warning">dev admin</Badge>
      </div>
    );
  }

  if (!me.data.user) {
    return (
      <Link href="/login" className="hover:text-ink">
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
        <Badge tone={me.data.user.role === "admin" ? "warning" : me.data.user.role === "approver" ? "success" : "info"}>
          {me.data.user.role}
        </Badge>
        <button type="button" onClick={signOut} className="hover:text-ink">
          Sign out
        </button>
      </div>
    </div>
  );
}

/** Brand lockup — monogram beside the Pebble wordmark and org line. */
function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <Image
        src="/brand/monogram.png"
        alt="Greenberg Engineering monogram"
        width={32}
        height={32}
        className="rounded-md"
      />
      <div className="min-w-0">
        <div className="text-sm font-semibold tracking-tight text-ink">Pebble</div>
        <div className="truncate text-xs text-ink-muted">Greenberg Engineering</div>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const me = trpc.users.me.useQuery();
  const NAV: NavItem[] = me.data?.user?.role === "admin" ? [...BASE_NAV, ...ADMIN_NAV] : BASE_NAV;
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="border-b border-border px-5 py-4">
          <BrandMark />
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-md px-3 py-2 text-sm font-medium transition ${
                isActive(pathname, item.href)
                  ? "bg-ink text-inverse"
                  : "text-ink hover:bg-grey-100"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-border px-5 py-3 text-xs text-ink-muted">
          <SessionFooter />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-5 py-3 md:hidden">
          <BrandMark />
          <nav className="flex gap-3 text-sm">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="text-ink-muted hover:text-ink">
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
