import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Neutral surface panel — flat card, no shadow. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-surface ${className}`}>{children}</div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink-secondary">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
};

export function Button({ variant = "secondary", className = "", ...props }: ButtonProps) {
  const base =
    "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const styles: Record<NonNullable<ButtonProps["variant"]>, string> = {
    primary: "bg-ink text-inverse hover:bg-grey-800",
    secondary: "border border-border bg-surface text-ink hover:bg-grey-100",
    danger: "bg-danger text-white hover:opacity-90",
    ghost: "text-ink-muted hover:text-ink",
  };
  return <button className={`${base} ${styles[variant]} ${className}`} {...props} />;
}

/**
 * Semantic Badge. Call sites pass a tone only; the component renders the glyph.
 * Legacy tones (green/red/amber/blue) are still accepted and mapped internally
 * so existing call sites compile untouched.
 */
type SemanticTone = "danger" | "warning" | "success" | "info" | "neutral";
type LegacyTone = "green" | "red" | "amber" | "blue";
export type BadgeTone = SemanticTone | LegacyTone;

const LEGACY_TONE_MAP: Record<LegacyTone, SemanticTone> = {
  green: "success",
  red: "danger",
  amber: "warning",
  blue: "info",
};

const TONE_STYLES: Record<SemanticTone, string> = {
  danger: "bg-danger-soft border border-danger-border text-danger font-semibold",
  warning: "bg-surface-sunken border border-border-strong text-ink",
  success: "border border-border-strong text-ink",
  info: "bg-surface-sunken text-ink-secondary",
  neutral: "border border-border text-ink-muted",
};

const TONE_GLYPH: Partial<Record<SemanticTone, string>> = {
  danger: "✕",
  warning: "!",
  success: "✓",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  const semantic: SemanticTone = tone in LEGACY_TONE_MAP ? LEGACY_TONE_MAP[tone as LegacyTone] : (tone as SemanticTone);
  const glyph = TONE_GLYPH[semantic];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONE_STYLES[semantic]}`}
    >
      {glyph ? <span aria-hidden>{glyph}</span> : null}
      {children}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted outline-none focus:border-ink";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface p-8 text-center text-sm text-ink-muted">
      {children}
    </div>
  );
}
