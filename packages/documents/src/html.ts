import { GST_RATE, formatINR } from "@pebble/shared";
import type { CompanyConfig, FormatAInput, FormatASection } from "./types";
import { groupLinesIntoSections, lineDescription } from "./types";

/**
 * Format A — HTML renderer. Produces a *single, self-contained* HTML document
 * (inline `<style>`, no external assets) that serves three roles at once:
 *  1. the on-screen quotation preview in the web app,
 *  2. the source the worker rasterises to PDF via headless Chromium, and
 *  3. a print-faithful A4 layout with a repeating letterhead + footer.
 *
 * Because the same string is shown to end users *and* fed arbitrary snapshot
 * text (client names, descriptions, notes), **every interpolated value is run
 * through `escapeHtml`**. Rupee amounts are produced by `formatINR` (digits and
 * "₹" only — safe) and the numeric labels are literals.
 *
 * On the two intentional omissions:
 *  - The corpus BOQ has an "Indicative Images" column; v1 omits it (see the note
 *    printed under the table and the `<!-- ... -->` comment in the markup). The
 *    seven columns rendered are exactly: Sl.No | Description | Unit | Qty |
 *    Unit Price (SITC) | Amount | Remarks.
 *  - Split "Supply Only" / "Labour" modes are not emitted in v1; only the
 *    combined-SITC document is produced (`input.mode` defaults to "combined").
 *
 * Page numbering: the worker supplies Chromium's `footerTemplate` for live page
 * numbers at PDF time (Chromium does not honour CSS `counter(page)` outside the
 * unsupported paged-media margin boxes). The fixed footer band below carries the
 * letterhead-consistent contact/bank strip that repeats on every printed page.
 */

/** Minimal, allocation-light HTML-entity escaper for interpolated text. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format an ISO date string as `DD Mon YYYY` without locale dependence. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${day} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Date `days` after an ISO date, as `DD Mon YYYY` (validity expiry display). */
function addDaysFormatted(iso: string, days: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d.toISOString());
}

/** GST percentage label derived from the shared rate (0.18 → "18%"). */
function gstPercentLabel(): string {
  return `${Number((GST_RATE * 100).toFixed(2))}%`;
}

/** Letterhead running header markup (repeats on every printed page). */
function renderLetterhead(company: CompanyConfig): string {
  const address = company.addressLines.map(escapeHtml).join("<br />");
  const contact = [
    company.phone ? `Tel: ${escapeHtml(company.phone)}` : "",
    company.email ? `Email: ${escapeHtml(company.email)}` : "",
    company.website ? escapeHtml(company.website) : "",
  ]
    .filter(Boolean)
    .join(" &nbsp;•&nbsp; ");

  // Brand block: monogram + wordmark images when configured (the house
  // letterhead), otherwise the text-only fallback. Data URIs only — the
  // template performs no I/O.
  const tagline = company.tagline
    ? `<div class="letterhead__tag">${escapeHtml(company.tagline)}</div>`
    : "";
  const brand = company.logoDataUri
    ? `
      <div class="letterhead__brandrow">
        <img class="letterhead__logo" src="${company.logoDataUri}" alt="" />
        <div>
          ${
            company.wordmarkDataUri
              ? `<img class="letterhead__wordmark" src="${company.wordmarkDataUri}" alt="${escapeHtml(company.name)}" />`
              : `<div class="letterhead__name">${escapeHtml(company.name)}</div>`
          }
          ${tagline}
        </div>
      </div>`
    : `
      <div class="letterhead__name">${escapeHtml(company.name)}</div>
      ${tagline || `<div class="letterhead__tag">Fire &amp; Life-Safety Systems — Design, Supply, Installation &amp; Commissioning</div>`}`;

  return `
    <header class="letterhead" role="banner">
      <div class="letterhead__brand">${brand}</div>
      <div class="letterhead__meta">
        <div>${address}</div>
        <div class="letterhead__gstin">GSTIN: ${escapeHtml(company.gstin)}</div>
        <div>${contact}</div>
      </div>
    </header>`;
}

/**
 * End-of-document CONTACT DETAILS | PAYMENT DETAILS strip. This mirrors the
 * real Format A corpus (e.g. FF-149): the letterhead prints once at the top of
 * page 1 and the signatory-contact + bank boxes close the document — there is
 * no repeating page footer band (page numbers ride in the renderer's footer
 * template instead).
 */
function renderContactPayment(company: CompanyConfig): string {
  const { bank } = company;
  return `
    <footer class="endblock" role="contentinfo">
      <div class="endblock__boxes">
        <div class="endblock__box">
          <div class="endblock__title">Contact Details</div>
          <div class="endblock__name">${escapeHtml(company.signatoryName)}</div>
          <div class="endblock__cred">${escapeHtml(company.signatoryCredentials)}</div>
          <div>MOB: ${escapeHtml(company.phone)}</div>
          <div>EMAIL: ${escapeHtml(company.email)}</div>
        </div>
        <div class="endblock__box">
          <div class="endblock__title">Payment Details</div>
          <div>Account Name: ${escapeHtml(bank.accountName)}</div>
          <div>Account Number: ${escapeHtml(bank.accountNumber)}</div>
          <div>Bank: ${escapeHtml(bank.bankName)}</div>
          ${bank.branch ? `<div>Branch: ${escapeHtml(bank.branch)}</div>` : ""}
          <div>IFSC Code: ${escapeHtml(bank.ifsc)}</div>
        </div>
      </div>
      <div class="endblock__note">This is a system-generated quotation and is valid without signature.</div>
    </footer>`;
}

/** The header block: Attn / client / project / date / est no / rev / validity. */
function renderHeaderBlock(input: FormatAInput): string {
  const { estimate, project } = input;
  const rows: Array<[string, string]> = [
    ["Attn.", escapeHtml(project.attention ?? project.clientName)],
    ["Client", escapeHtml(project.clientName)],
    ["Project", escapeHtml(project.projectName)],
  ];
  if (project.buildingType) rows.push(["Building Type", escapeHtml(project.buildingType)]);
  if (project.applicableStandard)
    rows.push(["Standard", escapeHtml(project.applicableStandard)]);
  if (project.clientEmail) rows.push(["Email", escapeHtml(project.clientEmail)]);
  if (project.clientPhone) rows.push(["Phone", escapeHtml(project.clientPhone)]);

  const validUntil = addDaysFormatted(estimate.dateISO, estimate.validityDays);
  const rightRows: Array<[string, string]> = [
    ["Estimate No.", escapeHtml(estimate.estimateId)],
    ["Revision", escapeHtml(estimate.revision)],
    ["Date", escapeHtml(formatDate(estimate.dateISO))],
    [
      "Validity",
      `Valid ${escapeHtml(String(estimate.validityDays))} days${
        validUntil ? ` (up to ${escapeHtml(validUntil)})` : ""
      }`,
    ],
  ];

  const renderRows = (pairs: Array<[string, string]>): string =>
    pairs
      .map(
        ([k, v]) =>
          `<tr><th scope="row">${escapeHtml(k)}</th><td>${v}</td></tr>`,
      )
      .join("");

  return `
    <section class="header-block">
      <table class="header-block__left"><tbody>${renderRows(rows)}</tbody></table>
      <table class="header-block__right"><tbody>${renderRows(rightRows)}</tbody></table>
    </section>`;
}

/** One section's `<tbody>`: a PART title row, the item rows, and a subtotal. */
function renderSection(section: FormatASection): string {
  const itemRows = section.lines
    .map((line, idx) => {
      const remarks = line.note && line.note.trim().length > 0 ? line.note : "—";
      const qtyDisplay = String(line.qty);
      return `
        <tr class="item">
          <td class="c-sl">${idx + 1}</td>
          <td class="c-desc">${escapeHtml(lineDescription(line))}</td>
          <td class="c-unit">${escapeHtml(line.unit)}</td>
          <td class="c-qty">${escapeHtml(qtyDisplay)}</td>
          <td class="c-rate">${escapeHtml(formatINR(line.sitcRatePaise))}</td>
          <td class="c-amt">${escapeHtml(formatINR(line.lineAmountPaise))}</td>
          <td class="c-rem">${escapeHtml(remarks)}</td>
        </tr>`;
    })
    .join("");

  return `
    <tbody class="section">
      <tr class="section__title">
        <td colspan="7">${escapeHtml(section.title)}</td>
      </tr>
      ${itemRows}
      <tr class="section__subtotal">
        <td colspan="5" class="c-subtotal-label">Sub-total — ${escapeHtml(section.systemLabel)}</td>
        <td class="c-amt">${escapeHtml(formatINR(section.subtotalPaise))}</td>
        <td class="c-rem"></td>
      </tr>
    </tbody>`;
}

/** The BOQ table (repeating column header + one tbody per section). */
function renderBoqTable(sections: FormatASection[]): string {
  const body = sections.map(renderSection).join("");
  return `
    <!-- The corpus BOQ carries an "Indicative Images" column; it is omitted in v1.
         Columns: Sl.No | Description | Unit | Qty | Unit Price (SITC) | Amount | Remarks -->
    <table class="boq">
      <thead>
        <tr>
          <th class="c-sl">Sl.No</th>
          <th class="c-desc">Description</th>
          <th class="c-unit">Unit</th>
          <th class="c-qty">Qty</th>
          <th class="c-rate">Unit Price (SITC)</th>
          <th class="c-amt">Amount</th>
          <th class="c-rem">Remarks</th>
        </tr>
      </thead>
      ${body}
    </table>
    <p class="boq-note">Note: Indicative product images are omitted in this version of the estimate.</p>`;
}

/** The money rollup: Total SITC → GST @ 18% → Grand Total (from `totals`). */
function renderRollup(input: FormatAInput): string {
  const { totals } = input;
  const ratioLine =
    input.blendedRatio != null
      ? `<div class="rollup__ratio">Blended SITC ratio: ${escapeHtml(
          input.blendedRatio.toFixed(3),
        )}${input.sitcStatus ? ` (${escapeHtml(input.sitcStatus)})` : ""}</div>`
      : "";

  return `
    <section class="rollup">
      <table class="rollup__table"><tbody>
        <tr>
          <th scope="row">Total (SITC)</th>
          <td>${escapeHtml(formatINR(totals.totalSitcPaise))}</td>
        </tr>
        <tr>
          <th scope="row">GST @ ${escapeHtml(gstPercentLabel())}</th>
          <td>${escapeHtml(formatINR(totals.gstPaise))}</td>
        </tr>
        <tr class="rollup__grand">
          <th scope="row">Grand Total</th>
          <td>${escapeHtml(formatINR(totals.grandTotalPaise))}</td>
        </tr>
      </tbody></table>
      ${ratioLine}
    </section>`;
}

/** Terms & Conditions ordered list. */
function renderTerms(company: CompanyConfig): string {
  const items = company.termsAndConditions
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join("");
  return `
    <section class="terms">
      <h2>Terms &amp; Conditions</h2>
      <ol>${items}</ol>
    </section>`;
}

// (The signatory's name/credentials print inside the CONTACT DETAILS box —
// the corpus Format A has no separate signature line.)

/** The embedded print/screen stylesheet (A4, repeating header/footer). */
function styles(): string {
  return `
    :root {
      --ink: #1a1a1a;
      --muted: #555;
      --line: #c9c9c9;
      --accent: #1f4e3d;
      --accent-soft: #eef4f1;
      --band: #f5f5f3;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      color: var(--ink);
      font-family: "Segoe UI", Arial, Helvetica, sans-serif;
      font-size: 11px;
      line-height: 1.45;
    }
    /* Page box: A4; the print margins come from the renderer's pdf() options
       (the pdf footer template carries the page numbers). The letterhead is
       in-flow at the top of page 1 — matching the issued corpus (FF-149),
       whose letterhead does not repeat on continuation pages. */
    @page {
      size: A4;
    }
    .letterhead {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 12px;
      padding-bottom: 6px;
      border-bottom: 2px solid var(--accent);
    }
    .letterhead__name {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: var(--accent);
    }
    .letterhead__tag { font-size: 10px; color: var(--muted); }
    .letterhead__brandrow { display: flex; align-items: center; gap: 8px; }
    .letterhead__logo { width: 34px; height: 34px; }
    .letterhead__wordmark { height: 20px; display: block; margin-bottom: 2px; }
    .letterhead__meta { text-align: right; font-size: 10px; color: var(--muted); }
    .letterhead__gstin { font-weight: 600; color: var(--ink); }
    .endblock { margin-top: 18px; page-break-inside: avoid; }
    .endblock__boxes { display: flex; gap: 0; border: 1px solid var(--ink); }
    .endblock__box {
      flex: 1 1 50%;
      padding: 6px 10px 8px;
      font-size: 9.5px;
    }
    .endblock__box + .endblock__box { border-left: 1px solid var(--ink); }
    .endblock__title {
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 2px;
      margin-bottom: 4px;
    }
    .endblock__name { font-weight: 700; }
    .endblock__cred { font-size: 8.5px; color: var(--muted); margin-bottom: 3px; }
    .endblock__note {
      margin-top: 6px;
      font-size: 8.5px;
      color: var(--muted);
      text-align: center;
    }
    main { display: block; }
    .doc-title {
      text-align: center;
      margin: 0 0 10px;
      font-size: 15px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--accent);
    }
    .doc-subtitle {
      text-align: center;
      margin: -6px 0 14px;
      font-size: 10px;
      color: var(--muted);
    }
    .header-block {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }
    .header-block table { border-collapse: collapse; font-size: 10.5px; }
    .header-block th {
      text-align: left;
      font-weight: 600;
      color: var(--muted);
      padding: 1px 10px 1px 0;
      white-space: nowrap;
      vertical-align: top;
    }
    .header-block td { padding: 1px 0; vertical-align: top; }
    .header-block__right th { text-align: right; padding-right: 10px; }
    table.boq {
      width: 100%;
      border-collapse: collapse;
      font-size: 10px;
    }
    table.boq th, table.boq td {
      border: 1px solid var(--line);
      padding: 4px 6px;
      vertical-align: top;
    }
    table.boq thead th {
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      text-align: center;
    }
    .c-sl { width: 6%; text-align: center; }
    .c-desc { width: 40%; }
    .c-unit { width: 8%; text-align: center; }
    .c-qty { width: 8%; text-align: right; }
    .c-rate { width: 15%; text-align: right; }
    .c-amt { width: 15%; text-align: right; }
    .c-rem { width: 8%; }
    .section__title td {
      background: var(--accent-soft);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--accent);
    }
    .section__subtotal td {
      background: var(--band);
      font-weight: 700;
    }
    .c-subtotal-label { text-align: right; }
    .boq-note { font-size: 9px; color: var(--muted); margin: 6px 0 0; font-style: italic; }
    .rollup { margin-top: 14px; display: flex; justify-content: flex-end; }
    .rollup__table { border-collapse: collapse; min-width: 46%; }
    .rollup__table th, .rollup__table td {
      border: 1px solid var(--line);
      padding: 5px 10px;
      font-size: 11px;
    }
    .rollup__table th { text-align: left; background: var(--band); }
    .rollup__table td { text-align: right; }
    .rollup__grand th, .rollup__grand td {
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      font-size: 12px;
    }
    .rollup__ratio { align-self: flex-end; font-size: 9px; color: var(--muted); margin-top: 4px; }
    .terms { margin-top: 18px; page-break-inside: avoid; }
    .terms h2 {
      font-size: 12px;
      color: var(--accent);
      border-bottom: 1px solid var(--line);
      padding-bottom: 3px;
      margin: 0 0 6px;
    }
    .terms ol { margin: 0; padding-left: 18px; }
    .terms li { margin-bottom: 3px; font-size: 9.5px; }
    @media screen {
      body { background: #ececec; }
      main {
        background: #fff;
        max-width: 210mm;
        margin: 18mm auto;
        padding: 16mm 14mm 20mm;
        box-shadow: 0 2px 12px rgba(0,0,0,0.15);
      }
    }`;
}

/**
 * Render the complete Format A quotation as a standalone HTML document string.
 * Pure: same input → identical output (no `Date.now()`, no randomness).
 */
export function renderFormatAHtml(input: FormatAInput): string {
  const sections = groupLinesIntoSections(input.lines);
  const { company } = input;
  const modeLabel =
    input.mode && input.mode !== "combined"
      ? input.mode === "supplyOnly"
        ? "Supply Only"
        : "Labour Charges"
      : "SITC (Supply, Installation, Testing &amp; Commissioning) — Combined";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(company.name)} — ${escapeHtml(input.estimate.estimateId)}</title>
  <style>${styles()}</style>
</head>
<body>
  <main>
    ${renderLetterhead(company)}
    <h1 class="doc-title">Budgetary Estimate / Quotation</h1>
    <div class="doc-subtitle">${modeLabel}</div>
    ${renderHeaderBlock(input)}
    ${renderBoqTable(sections)}
    ${renderRollup(input)}
    ${renderTerms(company)}
    ${renderContactPayment(company)}
  </main>
</body>
</html>`;
}
