/**
 * HTML → PDF rendering for Format A.
 *
 * Rationale (PLAN §4.6): the Format A document is an HTML/CSS template so a
 * single source drives the on-screen preview, print CSS, and the rasterised
 * PDF — dense 9-column BOQ tables with a repeating letterhead are exactly what
 * a browser engine renders well, and headless Chromium gives pixel-faithful,
 * paginated output with running headers/footers and page numbers.
 *
 * Two implementations sit behind one interface:
 *   - `PlaywrightPdfRenderer` launches Chromium (lazily, per render) and prints.
 *   - `StubPdfRenderer` returns a tiny deterministic buffer with no browser —
 *     the tested path, and the automatic fallback anywhere Chromium is absent
 *     (CI, this sandbox). Selection is env-driven via `createPdfRenderer`.
 */

export interface HtmlToPdf {
  /** Render a complete HTML document to PDF bytes. */
  render(html: string): Promise<Buffer>;
}

/** Chromium print options factory (kept here so both the header/footer chrome
 * and the A4 margins live in one place). Page numbers ride in the footer. */
function printOptions() {
  return {
    format: "A4" as const,
    printBackground: true,
    displayHeaderFooter: true,
    // Empty header keeps the top margin without a running title; the footer
    // carries centred "Page N of M" so multi-page BOQs are navigable in print.
    headerTemplate: "<span></span>",
    footerTemplate:
      '<div style="width:100%;font-size:9px;color:#666;text-align:center;padding:0 8mm;">' +
      'Page <span class="pageNumber"></span> of <span class="totalPages"></span>' +
      "</div>",
    margin: { top: "16mm", bottom: "18mm", left: "12mm", right: "12mm" },
  };
}

export interface PlaywrightPdfOptions {
  /** Absolute path to a Chromium/Chrome binary (`PLAYWRIGHT_CHROMIUM_EXECUTABLE`). */
  executablePath?: string;
  /** Installed browser channel to launch instead (e.g. `"chrome"`). */
  channel?: string;
}

/**
 * Production renderer. Chromium is launched *lazily on each render* and closed
 * in a `finally`, so constructing the renderer is side-effect free (no browser
 * process at boot) and a crashed render never leaks a browser. `playwright-core`
 * ships no browser binaries, hence the explicit `executablePath`/`channel`.
 */
export class PlaywrightPdfRenderer implements HtmlToPdf {
  readonly kind = "playwright";
  private readonly options: PlaywrightPdfOptions;

  constructor(options: PlaywrightPdfOptions = {}) {
    this.options = options;
  }

  async render(html: string): Promise<Buffer> {
    // Import inside render so the module loads even where the browser binding
    // is unavailable, and so no launch happens at construction.
    const { chromium } = await import("playwright-core");
    const launchOptions: Parameters<typeof chromium.launch>[0] = {};
    if (this.options.executablePath) {
      launchOptions.executablePath = this.options.executablePath;
    } else {
      launchOptions.channel = this.options.channel ?? "chrome";
    }

    const browser = await chromium.launch(launchOptions);
    try {
      const page = await browser.newPage();
      // `networkidle` ensures embedded fonts/inline assets settle before print.
      await page.setContent(html, { waitUntil: "networkidle" });
      const pdf = await page.pdf(printOptions());
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }
}

/**
 * Deterministic, network- and browser-free renderer. Emits a stable few-byte
 * buffer that starts with `%PDF` (enough for downstream code to treat it as a
 * PDF and for tests to assert on its content) and varies with the input length
 * so distinct documents yield distinct bytes/hashes. This is the load-bearing
 * path in tests and anywhere Chromium is not installed.
 */
export class StubPdfRenderer implements HtmlToPdf {
  readonly kind = "stub";

  async render(html: string): Promise<Buffer> {
    return Buffer.from(`%PDF-stub\n${html.length}`);
  }
}

/**
 * Pick a renderer from the environment. A real browser is used only when we
 * have somewhere to launch it: an explicit `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
 * (preferred — points at the exact binary) or `RENDER_PDF=1` (launch the
 * installed `chrome` channel). Otherwise the stub, so rendering never fails for
 * want of a browser.
 */
export function createPdfRenderer(env: Record<string, string | undefined>): HtmlToPdf {
  if (env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    return new PlaywrightPdfRenderer({ executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  }
  if (env.RENDER_PDF === "1") {
    return new PlaywrightPdfRenderer({ channel: "chrome" });
  }
  return new StubPdfRenderer();
}
