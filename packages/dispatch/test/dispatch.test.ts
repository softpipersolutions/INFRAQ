import { describe, expect, it } from "vitest";
import {
  StubEmailProvider,
  StubWhatsAppProvider,
  dispatchEstimate,
  type EstimateDispatchRequest,
} from "../src/index";

/** Fan-out orchestration: one request → email + WhatsApp with shared artifacts. */

const baseRequest: EstimateDispatchRequest = {
  toEmail: "client@example.com",
  toPhone: "919812345678",
  subject: "Estimate GB-2026-001",
  message: "Your fire-safety estimate is attached.",
};

describe("dispatchEstimate", () => {
  it("fans out to both channels and returns two SENT results", async () => {
    const email = new StubEmailProvider();
    const whatsapp = new StubWhatsAppProvider();

    const results = await dispatchEstimate({ email, whatsapp }, baseRequest);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.channel)).toEqual(["EMAIL", "WHATSAPP"]);
    expect(results.every((r) => r.result.status === "SENT")).toBe(true);

    // Each provider recorded exactly one message.
    expect(email.sent).toHaveLength(1);
    expect(whatsapp.sent).toHaveLength(1);
    expect(email.sent[0]?.subject).toBe("Estimate GB-2026-001");
    expect(whatsapp.sent[0]?.bodyText).toBe(baseRequest.message);
  });

  it("shares the same GCS artifact url across email attachment and WhatsApp media", async () => {
    const email = new StubEmailProvider();
    const whatsapp = new StubWhatsAppProvider();

    await dispatchEstimate(
      { email, whatsapp },
      {
        ...baseRequest,
        attachments: [{ filename: "boq.pdf", url: "https://signed.example/boq.pdf" }],
      },
    );

    expect(email.sent[0]?.attachments?.[0]).toMatchObject({
      url: "https://signed.example/boq.pdf",
    });
    // The URL artifact is offered to WhatsApp as media (same object, one action).
    expect(whatsapp.sent[0]?.mediaUrl).toBe("https://signed.example/boq.pdf");
  });

  it("sends email only when no phone / no whatsapp provider is given", async () => {
    const email = new StubEmailProvider();
    const results = await dispatchEstimate({ email }, { ...baseRequest, toPhone: undefined });
    expect(results).toHaveLength(1);
    expect(results[0]?.channel).toBe("EMAIL");
  });

  it("sends WhatsApp only when no email recipient is given", async () => {
    const whatsapp = new StubWhatsAppProvider();
    const results = await dispatchEstimate({ whatsapp }, { ...baseRequest, toEmail: undefined });
    expect(results).toHaveLength(1);
    expect(results[0]?.channel).toBe("WHATSAPP");
  });

  it("returns no results when nothing is routable", async () => {
    const results = await dispatchEstimate({}, baseRequest);
    expect(results).toEqual([]);
  });
});
