"use client";

import type { ReactNode } from "react";
// Explicit React import: the classic JSX runtime vitest falls back to for this
// workspace's tsconfig (`jsx: "preserve"`, which is Next's own SWC transform
// setting) needs `React` in scope wherever JSX is used; harmless under Next's
// actual automatic runtime in production.
import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Chat-safe Markdown renderer (Phase C.5 chat overhaul WP4).
 *
 * Deliberately react-markdown + remark-gfm rather than `streamdown`: streamdown's
 * default pipeline bundles rehype-raw + rehype-sanitize + rehype-harden (to
 * parse *and* selectively allow raw HTML/images) plus an optional mermaid
 * renderer, which is the opposite of what this surface wants — raw HTML must
 * stay inert escaped text, not sanitized-and-rendered, and model-supplied
 * images must never load. Plain react-markdown gives that behaviour for free
 * (no rehype-raw plugin -> raw HTML mdast nodes fall through as literal text)
 * with a much smaller, easier-to-audit dependency footprint.
 */

// ---------------------------------------------------------------------------
// Streaming guard
// ---------------------------------------------------------------------------

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/gm;
const TABLE_SEPARATOR_ROW = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Drops fenced code block *contents* (and the fence delimiter lines themselves) so inline-marker counting below never looks inside a code sample. */
function stripFencedBlocks(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let insideFence = false;
  for (const line of lines) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      insideFence = !insideFence;
      continue; // never keep a fence delimiter line itself
    }
    if (!insideFence) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * A message still mid-stream can end inside an unterminated construct — an
 * open code fence, an open inline-code backtick, an open `**bold**`, or a
 * table header whose separator row hasn't arrived yet. Left alone, each of
 * these swallows (or silently defers rendering of) everything that follows
 * until the construct closes, which reads as "broken" for the seconds it
 * takes the rest of the message to stream in. This closes the trailing
 * open construct so the partial message renders cleanly.
 *
 * This is a heuristic, not a CommonMark parser — it counts delimiters, so a
 * *complete* message that happens to contain a lone stray backtick/`**`
 * (rare) could get an extra closing character appended. Callers should only
 * apply this while a message is actively streaming; once the turn settles,
 * render the original, unmodified text.
 */
export function closeIncompleteMarkdown(text: string): string {
  if (!text) return text;

  const fenceLines = text.match(FENCE_LINE) ?? [];
  if (fenceLines.length % 2 === 1) {
    // Inside an open code fence — close it and stop; everything else is
    // literal code-block content until the real fence arrives.
    return text.endsWith("\n") ? `${text}\`\`\`` : `${text}\n\`\`\``;
  }

  let out = text;
  const outside = stripFencedBlocks(out);
  const backticks = (outside.match(/`/g) ?? []).length;
  if (backticks % 2 === 1) out += "`";
  const doubleStars = (outside.match(/\*\*/g) ?? []).length;
  if (doubleStars % 2 === 1) out += "**";
  const doubleUnderscores = (outside.match(/__/g) ?? []).length;
  if (doubleUnderscores % 2 === 1) out += "__";

  return closeIncompleteTable(out);
}

/**
 * If the tail of `text` is a table header row that hasn't been followed by
 * its GFM separator row yet, injects a synthetic separator so the table
 * renders immediately instead of sitting as a plain paragraph until the
 * separator streams in a beat later.
 */
function closeIncompleteTable(text: string): string {
  const lines = text.split("\n");
  let start = lines.length - 1;
  const lastLine = lines[start];
  if (lastLine === undefined || !lastLine.includes("|")) return text;
  while (start > 0) {
    const prevLine = lines[start - 1];
    if (prevLine === undefined || !prevLine.includes("|")) break;
    start -= 1;
  }

  const block = lines.slice(start);
  if (block.some((line) => TABLE_SEPARATOR_ROW.test(line))) return text; // already a table
  if (block.length !== 1) return text; // more than just a header row and still no separator — leave it

  const header = block[0];
  if (header === undefined || TABLE_SEPARATOR_ROW.test(header)) return text; // separator itself mid-typing

  const inner = header.trim().replace(/^\|/, "").replace(/\|$/, "");
  const columns = Math.max(1, inner.split("|").length);
  const separator = `|${" --- |".repeat(columns)}`;
  return `${text}\n${separator}`;
}

// ---------------------------------------------------------------------------
// Component map
// ---------------------------------------------------------------------------

function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (typeof node === "object" && "props" in node) {
    return flattenText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

const NUMERIC_CELL = /^[\s\-+.,₹$€£%0-9]+$/;

/** True when a table cell's rendered text is purely numeric/currency — used to opt it into `.tabular` (monospace, tabular-nums) alignment. */
function isNumericCell(children: ReactNode): boolean {
  const text = flattenText(children).trim();
  return text.length > 0 && NUMERIC_CELL.test(text);
}

/** http(s) or protocol-relative URLs are external; relative paths, `#anchors`, `mailto:`/`tel:` are not. */
function isExternalHref(href: string): boolean {
  return /^(https?:)?\/\//i.test(href);
}

const linkClass = "underline text-ink hover:text-ink-secondary";

const components: Components = {
  p: ({ children }) => <p className="text-sm leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-1 pl-5 text-sm">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-1 pl-5 text-sm">{children}</ol>,
  li: ({ children }) => <li className="text-sm leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  hr: () => <hr className="my-3 border-border" />,

  a: ({ href, children }) => {
    const url = href ?? "";
    const external = isExternalHref(url);
    return (
      <a
        href={url}
        className={linkClass}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </a>
    );
  },

  // Never load a model-supplied image — render it as a plain link instead.
  img: ({ src, alt }) => {
    const url = typeof src === "string" ? src : "";
    if (!url) return null;
    const external = isExternalHref(url);
    return (
      <a
        href={url}
        className={linkClass}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {alt || url}
      </a>
    );
  },

  h1: ({ children }) => <h1 className="mt-3 mb-1 text-base font-semibold text-ink first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1 text-sm font-semibold text-ink first:mt-0">{children}</h2>,
  h3: ({ children }) => (
    <h3 className="mt-2 mb-1 text-sm font-semibold text-ink-secondary first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2 mb-1 text-sm font-semibold text-ink-secondary first:mt-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-2 mb-1 text-sm font-semibold text-ink-secondary first:mt-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mt-2 mb-1 text-sm font-semibold text-ink-secondary first:mt-0">{children}</h6>
  ),

  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border-strong pl-3 text-sm text-ink-secondary">
      {children}
    </blockquote>
  ),

  code: ({ className, children, node }) => {
    const isBlock = node?.position ? node.position.start.line !== node.position.end.line : false;
    if (isBlock) {
      return <code className={`font-mono text-[13px] ${className ?? ""}`}>{children}</code>;
    }
    return <code className="rounded bg-surface-sunken px-1 font-mono text-[13px]">{children}</code>;
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border border-border bg-surface-sunken p-3">
      {children}
    </pre>
  ),

  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full text-sm border border-border">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-surface-sunken text-xs uppercase text-ink-secondary">{children}</thead>
  ),
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children, style }) => (
    <th
      className={`border-b border-border px-2 py-1 text-left font-medium ${isNumericCell(children) ? "tabular" : ""}`}
      style={style}
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      className={`border-b border-border px-2 py-1 ${isNumericCell(children) ? "tabular" : ""}`}
      style={style}
    >
      {children}
    </td>
  ),
};

/**
 * Renders assistant markdown onto the monochrome design system. `remark-gfm`
 * is on (tables, strikethrough, task lists, autolinks); there is no rehype-raw,
 * so any raw HTML in `text` — including a model-supplied `<img onerror=…>` —
 * renders as inert escaped text, never as a live element.
 *
 * Pass `streaming` while this text part is still actively arriving (the
 * current in-flight assistant turn) to run the incomplete-construct guard;
 * omit it (or pass `false`) once the turn has settled so the exact source
 * text renders.
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const source = streaming ? closeIncompleteMarkdown(text) : text;
  return (
    <div className="space-y-2 text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
