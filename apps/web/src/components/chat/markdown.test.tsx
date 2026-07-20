import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { closeIncompleteMarkdown, Markdown } from "./markdown";

/**
 * apps/web has no jsdom/testing-library (see tool-activity.test.ts), but
 * `react-dom/server`'s `renderToStaticMarkup` needs no DOM at all — it's a
 * plain Node-side string renderer — so it's enough for a real smoke test of
 * the <Markdown/> component map, not just its pure-function config.
 */

function render(text: string, streaming = false): string {
  return renderToStaticMarkup(<Markdown text={text} streaming={streaming} />);
}

describe("Markdown component", () => {
  it("renders a GFM table with the design-system table classes", () => {
    const html = render("| Name | Qty |\n|:---|---:|\n| Foo | 12 |\n");
    expect(html).toContain("<table");
    expect(html).toContain('class="w-full text-sm border border-border"');
    expect(html).toContain("<thead");
    expect(html).toContain("Foo");
    expect(html).toContain("12");
  });

  it("marks a purely-numeric table cell as .tabular but not a text cell", () => {
    const html = render("| Name | Qty |\n|---|---|\n| Foo | 12 |\n");
    expect(html).toMatch(/<td class="[^"]*\btabular\b[^"]*">12<\/td>/);
    expect(html).not.toMatch(/<td class="[^"]*\btabular\b[^"]*">Foo<\/td>/);
  });

  it("renders a fenced code block inside a styled <pre>", () => {
    const html = render("```js\nconst x = 1;\n```\n");
    expect(html).toContain("<pre");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("const x = 1;");
  });

  it("renders inline code with the compact inline style, not the block <pre> style", () => {
    const html = render("Use `npm install` to set up.");
    expect(html).toContain("<code");
    expect(html).not.toContain("<pre");
    expect(html).toContain("npm install");
  });

  it("never renders a model-supplied raw <img> — it stays escaped text, not a live element", () => {
    const html = render('Look: <img src=x onerror="alert(1)"> done.');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=\"alert(1)\"");
    expect(html).toContain("&lt;img");
  });

  it("renders a markdown image as a plain link, never an <img> element", () => {
    const html = render("![a chart](https://evil.example/track.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("<a");
    expect(html).toContain("https://evil.example/track.png");
    expect(html).toContain("a chart");
  });

  it("opens external links in a new tab with rel=noopener, but not internal links", () => {
    const html = render("[docs](https://example.com/docs) and [home](/dashboard)");
    expect(html).toMatch(/<a href="https:\/\/example\.com\/docs"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    expect(html).not.toMatch(/<a href="\/dashboard"[^>]*target="_blank"/);
  });

  it("bolds strong text with font-semibold", () => {
    const html = render("This is **important**.");
    expect(html).toMatch(/<strong class="font-semibold">important<\/strong>/);
  });

  it("keeps headings compact (max text-base)", () => {
    const html = render("# Big\n## Medium\n### Small");
    expect(html).toContain('class="mt-3 mb-1 text-base font-semibold text-ink first:mt-0"');
    expect(html).not.toContain("text-lg");
    expect(html).not.toContain("text-xl");
    expect(html).not.toContain("text-2xl");
  });
});

describe("closeIncompleteMarkdown", () => {
  it("is a no-op on well-formed complete text", () => {
    const text = "Hello **world**, see `code` and:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(closeIncompleteMarkdown(text)).toBe(text);
  });

  it("closes an unterminated code fence", () => {
    const out = closeIncompleteMarkdown("Here's some code:\n\n```js\nconst x = 1;\n");
    expect(out.match(/```/g)?.length).toBe(2);
    expect(out.endsWith("```")).toBe(true);
  });

  it("does not touch a fence that is already balanced", () => {
    const text = "```js\nconst x = 1;\n```\n";
    expect(closeIncompleteMarkdown(text)).toBe(text);
  });

  it("closes a dangling inline code backtick", () => {
    const out = closeIncompleteMarkdown("Run `npm install");
    expect(out).toBe("Run `npm install`");
  });

  it("closes a dangling bold marker", () => {
    const out = closeIncompleteMarkdown("This is **important");
    expect(out).toBe("This is **important**");
  });

  it("does not touch backticks that live inside an already-open fence", () => {
    const out = closeIncompleteMarkdown("```\nconst s = `templ`;\n");
    // fence itself is unterminated -> only the fence gets closed, not a stray backtick fix
    expect(out).toBe("```\nconst s = `templ`;\n```");
  });

  it("injects a synthetic separator row for a streamed table header with no separator yet", () => {
    const out = closeIncompleteMarkdown("Here:\n\n| Name | Qty |");
    expect(out).toBe("Here:\n\n| Name | Qty |\n| --- | --- |");
  });

  it("leaves an already-separated table alone", () => {
    const text = "| Name | Qty |\n|---|---|\n| Foo | 12 |";
    expect(closeIncompleteMarkdown(text)).toBe(text);
  });

  it("leaves a mid-typed separator row alone rather than guessing", () => {
    const text = "| Name | Qty |\n|---|--";
    expect(closeIncompleteMarkdown(text)).toBe(text);
  });
});
