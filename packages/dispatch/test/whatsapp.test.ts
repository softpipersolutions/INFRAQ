import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiSensyWhatsAppProvider,
  GupshupWhatsAppProvider,
  StubWhatsAppProvider,
  createWhatsAppProvider,
  type WhatsAppMessage,
} from "../src/index";

/** WhatsApp adapter behaviour + env-driven selection (no network in any case). */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createWhatsAppProvider", () => {
  it("defaults to the stub when WHATSAPP_PROVIDER is unset", () => {
    expect(createWhatsAppProvider({})).toBeInstanceOf(StubWhatsAppProvider);
  });

  it("selects AiSensy when configured with a key", () => {
    const provider = createWhatsAppProvider({
      WHATSAPP_PROVIDER: "aisensy",
      AISENSY_API_KEY: "ak_test",
    });
    expect(provider).toBeInstanceOf(AiSensyWhatsAppProvider);
    expect((provider as AiSensyWhatsAppProvider).provider).toBe("aisensy");
  });

  it("falls back to the stub when aisensy is selected but the key is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = createWhatsAppProvider({ WHATSAPP_PROVIDER: "aisensy" });
    expect(provider).toBeInstanceOf(StubWhatsAppProvider);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("selects Gupshup when key + source are present", () => {
    const provider = createWhatsAppProvider({
      WHATSAPP_PROVIDER: "gupshup",
      GUPSHUP_API_KEY: "gk_test",
      GUPSHUP_SOURCE: "919812345678",
    });
    expect(provider).toBeInstanceOf(GupshupWhatsAppProvider);
  });

  it("falls back to the stub when gupshup is missing its source number", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = createWhatsAppProvider({
      WHATSAPP_PROVIDER: "gupshup",
      GUPSHUP_API_KEY: "gk_test",
    });
    expect(provider).toBeInstanceOf(StubWhatsAppProvider);
  });

  it("falls back to the stub on an unknown provider name", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createWhatsAppProvider({ WHATSAPP_PROVIDER: "twilio" })).toBeInstanceOf(
      StubWhatsAppProvider,
    );
  });
});

describe("StubWhatsAppProvider", () => {
  it("records the sent message and returns SENT with a stub id", async () => {
    const provider = new StubWhatsAppProvider();
    const msg: WhatsAppMessage = {
      to: "919812345678",
      bodyText: "Your estimate is ready.",
    };

    const result = await provider.send(msg);

    expect(result).toMatchObject({ ok: true, status: "SENT", provider: "stub" });
    expect(result.providerMessageId).toBe("stub-wa-1");
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toBe(msg);
  });

  it("increments the stub id per send", async () => {
    const provider = new StubWhatsAppProvider();
    const first = await provider.send({ to: "1", bodyText: "a" });
    const second = await provider.send({ to: "2", bodyText: "b" });
    expect(first.providerMessageId).toBe("stub-wa-1");
    expect(second.providerMessageId).toBe("stub-wa-2");
  });
});

describe("real WhatsApp adapters (construction is side-effect-free)", () => {
  it("constructs AiSensy/Gupshup without touching the network", () => {
    // Fetch is left un-mocked deliberately; if construction called it, this
    // would throw or hang. Building the adapters must not send anything.
    expect(() => new AiSensyWhatsAppProvider({ apiKey: "x" })).not.toThrow();
    expect(() => new GupshupWhatsAppProvider({ apiKey: "x", source: "1" })).not.toThrow();
  });

  it("AiSensy maps a non-ok HTTP response to a FAILED result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "invalid campaign" }), { status: 400 }),
    );
    const provider = new AiSensyWhatsAppProvider({ apiKey: "x", campaignName: "estimate" });
    const result = await provider.send({ to: "919812345678", bodyText: "hi" });
    expect(result).toMatchObject({ ok: false, status: "FAILED", provider: "aisensy" });
    expect(result.error).toBe("invalid campaign");
  });

  it("AiSensy maps a network throw to a FAILED result", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const provider = new AiSensyWhatsAppProvider({ apiKey: "x" });
    const result = await provider.send({ to: "919812345678", bodyText: "hi" });
    expect(result).toMatchObject({ ok: false, status: "FAILED", error: "ECONNREFUSED" });
  });

  it("Gupshup maps a 2xx submission to SENT with the returned messageId", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "submitted", messageId: "gs-123" }), { status: 200 }),
      );
    const provider = new GupshupWhatsAppProvider({
      apiKey: "gk",
      source: "919812345678",
      appName: "GreenbergApp",
    });
    const result = await provider.send({ to: "919800000000", bodyText: "hi" });
    expect(result).toMatchObject({ ok: true, status: "SENT", providerMessageId: "gs-123" });
    // Confirms the documented endpoint + form-encoded body were used.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/sm/api/v1/msg");
    expect(String(init?.body)).toContain("destination=919800000000");
  });
});
