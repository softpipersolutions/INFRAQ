import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

/** Minimal public chrome — white page, slim brand topbar, footer. No auth shell. */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/brand/monogram.png"
            alt="Greenberg Engineering monogram"
            width={28}
            height={28}
            className="rounded"
          />
          <Image
            src="/brand/wordmark.png"
            alt="GREENBERG ENGINEERING"
            width={180}
            height={16}
            className="h-4 w-auto"
          />
        </Link>
        <Link href="/login" className="text-sm font-medium text-ink hover:text-ink-secondary">
          Sign in
        </Link>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border px-5 py-4 text-xs text-ink-muted">
        Greenberg Engineering Private Limited · GSTIN 09AAAAA0000A1Z5 · www.greenberg.example ·
        Exploring Synergy, Empowering Lives!
      </footer>
    </div>
  );
}
