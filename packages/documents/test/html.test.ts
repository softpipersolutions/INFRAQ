import { formatINR } from "@pebble/shared";
import { describe, expect, it } from "vitest";
import { renderFormatAHtml } from "../src/index";
import { fixtureInput, fixtureTotals } from "./fixture";

/**
 * Format A HTML: the rendered document must carry the estimate identity, the
 * client, the company GSTIN, each PART section title, the GST line, and the
 * grand total formatted exactly as `formatINR` produces it. It must also escape
 * hostile snapshot text so a `<script>` in a field can never reach the DOM.
 */
describe("renderFormatAHtml", () => {
  const input = fixtureInput();
  const html = renderFormatAHtml(input);
  const totals = fixtureTotals();

  it("is a complete standalone HTML document", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).toContain("@page");
  });

  it("shows the estimate no., revision, client, project and GSTIN", () => {
    expect(html).toContain("GBE-EST-2025-014");
    expect(html).toContain("R1");
    expect(html).toContain("Woodgrove Retail Ltd");
    expect(html).toContain("Woodgrove Marketplace Mall, Riverside Nagar");
    expect(html).toContain(input.company.gstin);
    expect(html).toContain("GSTIN:");
  });

  it("renders one PART section title per system", () => {
    expect(html).toContain("PART I — FIRE ALARM SYSTEM");
    expect(html).toContain("PART II — PORTABLE FIRE EXTINGUISHERS");
  });

  it("embeds the make/brand in the description", () => {
    expect(html).toContain("Make: Honeywell");
    expect(html).toContain("Make: Safepro");
  });

  it("has the seven BOQ columns and omits the images column", () => {
    expect(html).toContain("Sl.No");
    expect(html).toContain("Unit Price (SITC)");
    expect(html).toContain("Remarks");
    expect(html).toContain("Indicative product images are omitted");
    // The omitted column header must not appear as a table heading.
    expect(html).not.toContain("Indicative Images</th>");
  });

  it("shows the GST @ 18% line and the grand total via formatINR", () => {
    expect(html).toContain("GST @ 18%");
    expect(html).toContain(formatINR(totals.totalSitcPaise));
    expect(html).toContain(formatINR(totals.gstPaise));
    expect(html).toContain(formatINR(totals.grandTotalPaise));
  });

  it("prints the T&C and signatory credentials", () => {
    expect(html).toContain("Terms &amp; Conditions");
    expect(html).toContain("A. Sample");
    expect(html).toContain("Fire Safety Engineer");
    // Default (synthetic) letterhead facts.
    expect(html).toContain("09AAAAA0000A1Z5");
    expect(html).toContain("Greenberg Engineering Private Limited");
  });

  it("escapes a <script> injection in a text field", () => {
    const hostile = fixtureInput({
      attention: '<script>alert("xss")</script>',
    });
    const out = renderFormatAHtml(hostile);
    // The raw executable tag must never survive into the document.
    expect(out).not.toContain('<script>alert("xss")</script>');
    // It must be present only in escaped form.
    expect(out).toContain("&lt;script&gt;");
    // Sanity: the document still has its own (legitimate) markup.
    expect(out).toContain("<table class=\"boq\">");
  });
});
