import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_FROM,
  ResendEmailProvider,
  StubEmailProvider,
  createEmailProvider,
  type EmailMessage,
} from "../src/index";

/** Email adapter behaviour + env-driven selection (no network in any case). */

describe("createEmailProvider", () => {
  it("returns a StubEmailProvider when RESEND_API_KEY is absent", () => {
    const provider = createEmailProvider({});
    expect(provider).toBeInstanceOf(StubEmailProvider);
  });

  it("returns a ResendEmailProvider when RESEND_API_KEY is set, without sending", () => {
    const provider = createEmailProvider({ RESEND_API_KEY: "re_test_key" });
    expect(provider).toBeInstanceOf(ResendEmailProvider);
    // Constructing must be side-effect-free — the tag confirms the real adapter.
    expect((provider as ResendEmailProvider).provider).toBe("resend");
  });

  it("reads the default from address from DISPATCH_EMAIL_FROM", () => {
    const provider = createEmailProvider({ DISPATCH_EMAIL_FROM: "ops@greenberg.co.in" });
    expect((provider as StubEmailProvider).defaultFrom).toBe("ops@greenberg.co.in");
  });

  it("falls back to the Greenberg default from address", () => {
    const provider = createEmailProvider({});
    expect((provider as StubEmailProvider).defaultFrom).toBe(DEFAULT_EMAIL_FROM);
  });
});

describe("StubEmailProvider", () => {
  it("records the sent message and returns SENT with a stub id", async () => {
    const provider = new StubEmailProvider();
    const msg: EmailMessage = {
      to: "client@example.com",
      from: DEFAULT_EMAIL_FROM,
      subject: "Estimate GB-2026-001",
      text: "Please find attached.",
    };

    const result = await provider.send(msg);

    expect(result).toMatchObject({ ok: true, status: "SENT", provider: "stub" });
    expect(result.providerMessageId).toBe("stub-email-1");
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toBe(msg);
  });

  it("preserves attachments (both inline-bytes and url artifacts) on the record", async () => {
    const provider = new StubEmailProvider();
    const pdf = Buffer.from("%PDF-1.7 fake");
    await provider.send({
      to: "client@example.com",
      from: DEFAULT_EMAIL_FROM,
      subject: "Estimate",
      html: "<p>hi</p>",
      attachments: [
        { filename: "estimate.pdf", content: pdf, contentType: "application/pdf" },
        { filename: "boq.xlsx", url: "https://signed.example/boq.xlsx" },
      ],
    });

    const recorded = provider.sent[0];
    expect(recorded?.attachments).toHaveLength(2);
    expect(recorded?.attachments?.[0]).toMatchObject({
      filename: "estimate.pdf",
      content: pdf,
    });
    expect(recorded?.attachments?.[1]).toMatchObject({
      filename: "boq.xlsx",
      url: "https://signed.example/boq.xlsx",
    });
  });

  it("increments the stub id per send", async () => {
    const provider = new StubEmailProvider();
    const base: EmailMessage = { to: "a@b.com", from: DEFAULT_EMAIL_FROM, subject: "s", text: "t" };
    const first = await provider.send(base);
    const second = await provider.send(base);
    expect(first.providerMessageId).toBe("stub-email-1");
    expect(second.providerMessageId).toBe("stub-email-2");
  });
});
