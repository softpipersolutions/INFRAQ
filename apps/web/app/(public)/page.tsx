import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Public landing page for Pebble — strict-monochrome (black / white / grey, no
 * red anywhere), generous whitespace, crisp 1px borders. Fully static server
 * component: no tRPC, no client JS. Middleware serves "/" publicly and
 * redirects signed-in users to /dashboard before they reach this page.
 */

const btnPrimary =
  "inline-flex items-center justify-center rounded-md bg-ink px-5 py-2.5 text-sm font-medium text-inverse transition hover:bg-grey-800";
const btnGhost =
  "inline-flex items-center justify-center rounded-md px-5 py-2.5 text-sm font-medium text-ink-muted transition hover:text-ink";

const steps = [
  {
    n: "01",
    title: "Describe the project",
    body: "Chat in plain language, or the structured enquiry form — Pebble captures client, building, floors, and systems.",
  },
  {
    n: "02",
    title: "Engines price it",
    body: "Deterministic paise-level math — SITC within the 1.35–1.51 band, margin floors enforced; no AI ever computes a price.",
  },
  {
    n: "03",
    title: "Approve & dispatch",
    body: "Human-only approval, branded PDF & Excel on the Greenberg letterhead, emailed with a full audit trail.",
  },
];

const features = [
  {
    title: "Agentic chat intake",
    body: "A Claude-powered assistant that understands requirements, checks design rules, and cites past jobs.",
  },
  {
    title: "Deterministic engines",
    body: "Integer-paise arithmetic, versioned estimates, and replayable snapshots.",
  },
  {
    title: "Append-only audit",
    body: "Every change recorded; version compare built in.",
  },
  {
    title: "Institutional memory",
    body: "Knowledge base distilled from 145 real proposals and 2,000+ priced line items.",
  },
];

const stats = [
  { value: "145", label: "proposals ingested" },
  { value: "2,000+", label: "priced items" },
  { value: "26", label: "design rules" },
  { value: "1.43", label: "SITC target" },
];

export default function LandingPage() {
  return (
    <div className="mx-auto max-w-5xl px-6">
      {/* HERO */}
      <section className="flex flex-col items-start pb-20 pt-20 sm:pt-28">
        <div className="rounded-xl border border-border bg-surface p-2.5 shadow-raised">
          <Image
            src="/brand/monogram.png"
            alt="Greenberg Engineering monogram"
            width={56}
            height={56}
            className="h-14 w-14 rounded-lg"
          />
        </div>
        <p className="mt-8 text-xs uppercase tracking-[0.2em] text-ink-muted">
          INFRAQ — Agentic ERP for Engineering Firms
        </p>
        <h1 className="mt-4 max-w-3xl text-5xl font-semibold tracking-tight text-ink sm:text-6xl">
          Fire-safety estimates, from enquiry to audited BOQ.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-ink-secondary">
          Pebble · Module 02 — Estimate Crafting Space by Greenberg Engineering
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <Link href="/login" className={btnPrimary}>
            Sign in
          </Link>
          <a href="#how" className={btnGhost}>
            How it works
          </a>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" className="scroll-mt-24 border-t border-border py-20">
        <SectionKicker>How it works</SectionKicker>
        <div className="mt-8 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
          {steps.map((step) => (
            <div key={step.n} className="flex flex-col bg-surface p-7">
              <span className="tabular text-sm text-ink-muted">{step.n}</span>
              <h3 className="mt-4 text-lg font-semibold tracking-tight text-ink">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURE GRID */}
      <section className="border-t border-border py-20">
        <SectionKicker>What&apos;s inside</SectionKicker>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-border bg-surface p-7 shadow-raised"
            >
              <h3 className="text-lg font-semibold tracking-tight text-ink">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* STAT BAND */}
      <section className="border-t border-border py-20">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="bg-surface px-6 py-8 text-center">
              <div className="tabular text-3xl font-semibold tracking-tight text-ink">
                {stat.value}
              </div>
              <div className="mt-2 text-xs uppercase tracking-[0.12em] text-ink-muted">
                {stat.label}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-lg italic text-ink-muted">
          Exploring Synergy, Empowering Lives!
        </p>
      </section>

      {/* CLOSING CTA */}
      <section className="pb-24">
        <div className="flex flex-col items-center rounded-xl border border-border bg-surface px-6 py-16 text-center shadow-raised">
          <h2 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Ready when you are.
          </h2>
          <div className="mt-8">
            <Link href="/login" className={btnPrimary}>
              Sign in
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function SectionKicker({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs uppercase tracking-[0.2em] text-ink-muted">{children}</p>
  );
}
