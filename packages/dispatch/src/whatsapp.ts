import type { SendResult } from "./types";

/**
 * WhatsApp channel (spec 4.7). A pluggable `WhatsAppProvider` interface with a
 * network-free `Stub` (ships first — dispatch demos before any vendor contract
 * is signed) plus faithful `AiSensy` and `Gupshup` adapters. The concrete
 * provider is chosen at runtime by `WHATSAPP_PROVIDER`, so swapping vendors is
 * an env change, not a code change (top-risks #7: "WhatsApp vendor risk").
 *
 * The real adapters POST via the global `fetch` (Node 22+) rather than pulling
 * in an HTTP client dependency. They are structured to the vendors' documented
 * request shapes but are necessarily untested against live APIs (no creds); the
 * stub is the tested, load-bearing path for Phase 3.
 */

export interface WhatsAppMessage {
  /** Recipient MSISDN in E.164-ish form (digits, optional leading +). */
  to: string;
  /** Approved template name — required for business-initiated (out-of-session) sends. */
  templateName?: string;
  /** Free-form body (session messages) or the template's body fallback. */
  bodyText?: string;
  /** Media URL (image/document) — typically a signed GCS artifact URL. */
  mediaUrl?: string;
  /** Ordered template variable substitutions, keyed by position ("1", "2", …). */
  variables?: Record<string, string>;
}

export interface WhatsAppProvider {
  /** Attempt to send `msg`. Never throws — transport errors map to a FAILED result. */
  send(msg: WhatsAppMessage): Promise<SendResult>;
}

/** Template variables → the positional array both vendors expect (sorted by key). */
function orderedTemplateParams(variables: Record<string, string> | undefined): string[] {
  if (!variables) return [];
  return Object.keys(variables)
    .sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      // Numeric keys ("1","2",…) sort numerically; fall back to lexical.
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .map((k) => variables[k] ?? "");
}

/**
 * In-memory WhatsApp adapter for tests, local dev, and demos. Records every
 * message on `.sent` and reports SENT with a deterministic `stub-wa-<n>` id.
 * Zero-config default of `createWhatsAppProvider`.
 */
export class StubWhatsAppProvider implements WhatsAppProvider {
  readonly provider = "stub";
  /** Every message handed to `send`, in call order. */
  readonly sent: WhatsAppMessage[] = [];

  async send(msg: WhatsAppMessage): Promise<SendResult> {
    this.sent.push(msg);
    return {
      ok: true,
      status: "SENT",
      providerMessageId: `stub-wa-${this.sent.length}`,
      error: null,
      provider: this.provider,
    };
  }
}

export interface AiSensyConfig {
  apiKey: string;
  /** Default campaign (per-message `templateName` overrides it). */
  campaignName?: string;
  /** AiSensy account "userName" the campaign belongs to. */
  userName?: string;
  /** Override for tests / self-hosted; defaults to the public API. */
  apiUrl?: string;
}

const AISENSY_DEFAULT_URL = "https://backend.aisensy.com/campaign/t1/api/v2";

/**
 * AiSensy adapter — their "API Campaign" v2 endpoint. Auth and routing all ride
 * in the JSON body (`apiKey`, `campaignName`, `destination`, `userName`), with
 * `templateParams` carrying the approved-template substitutions and an optional
 * `media` object for attachments. No fetch happens at construction.
 */
export class AiSensyWhatsAppProvider implements WhatsAppProvider {
  readonly provider = "aisensy";
  private readonly config: AiSensyConfig;

  constructor(config: AiSensyConfig) {
    this.config = config;
  }

  async send(msg: WhatsAppMessage): Promise<SendResult> {
    const url = this.config.apiUrl ?? AISENSY_DEFAULT_URL;
    const body: Record<string, unknown> = {
      apiKey: this.config.apiKey,
      campaignName: msg.templateName ?? this.config.campaignName ?? "",
      destination: msg.to,
      userName: this.config.userName ?? "",
      templateParams: orderedTemplateParams(msg.variables),
    };
    if (msg.mediaUrl) {
      body.media = { url: msg.mediaUrl, filename: "attachment" };
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readJson(res);
      if (!res.ok) {
        return {
          ok: false,
          status: "FAILED",
          providerMessageId: null,
          error: providerError(res.status, payload),
          provider: this.provider,
        };
      }
      return {
        ok: true,
        status: "SENT",
        // AiSensy echoes a submission id under a few names across plans.
        providerMessageId: pickId(payload, ["messageId", "id", "submitId"]),
        error: null,
        provider: this.provider,
      };
    } catch (err) {
      return failedFromThrow(err, this.provider);
    }
  }
}

export interface GupshupConfig {
  apiKey: string;
  /** Registered WhatsApp source number (the "from"). */
  source: string;
  /** Registered app name (`src.name`). */
  appName?: string;
  /** Override for tests / self-hosted; defaults to the public API. */
  apiUrl?: string;
}

const GUPSHUP_DEFAULT_URL = "https://api.gupshup.io/sm/api/v1/msg";

/**
 * Gupshup adapter — the `/sm/api/v1/msg` send endpoint. Auth is the `apikey`
 * header; the message is a URL-encoded form where `message` is a JSON string
 * describing a text or media payload (Gupshup's documented shape). No fetch
 * happens at construction.
 */
export class GupshupWhatsAppProvider implements WhatsAppProvider {
  readonly provider = "gupshup";
  private readonly config: GupshupConfig;

  constructor(config: GupshupConfig) {
    this.config = config;
  }

  async send(msg: WhatsAppMessage): Promise<SendResult> {
    const url = this.config.apiUrl ?? GUPSHUP_DEFAULT_URL;
    // Media messages carry the artifact URL; otherwise a plain text body.
    const message = msg.mediaUrl
      ? { type: "file", url: msg.mediaUrl, filename: "attachment", caption: msg.bodyText ?? "" }
      : { type: "text", text: msg.bodyText ?? "" };
    const form = new URLSearchParams({
      channel: "whatsapp",
      source: this.config.source,
      destination: msg.to,
      message: JSON.stringify(message),
    });
    if (this.config.appName) form.set("src.name", this.config.appName);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          apikey: this.config.apiKey,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
      const payload = await readJson(res);
      if (!res.ok) {
        return {
          ok: false,
          status: "FAILED",
          providerMessageId: null,
          error: providerError(res.status, payload),
          provider: this.provider,
        };
      }
      return {
        ok: true,
        status: "SENT",
        providerMessageId: pickId(payload, ["messageId", "id"]),
        error: null,
        provider: this.provider,
      };
    } catch (err) {
      return failedFromThrow(err, this.provider);
    }
  }
}

/** Parse a JSON body defensively — providers occasionally return text/HTML on error. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Extract the first present string id from a candidate key list. */
function pickId(payload: unknown, keys: string[]): string | null {
  if (payload && typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    for (const key of keys) {
      const v = rec[key];
      if (typeof v === "string" && v) return v;
    }
  }
  return null;
}

function providerError(httpStatus: number, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    const msg = rec.message ?? rec.error ?? rec.reason;
    if (typeof msg === "string" && msg) return msg;
  }
  if (typeof payload === "string" && payload) return payload;
  return `HTTP ${httpStatus}`;
}

function failedFromThrow(err: unknown, provider: string): SendResult {
  return {
    ok: false,
    status: "FAILED",
    providerMessageId: null,
    error: err instanceof Error ? err.message : String(err),
    provider,
  };
}

/**
 * Pick a WhatsApp adapter from the environment. `WHATSAPP_PROVIDER` selects the
 * vendor; when unset — or when the selected vendor's credentials are missing —
 * we fall back to the stub and warn, never throw. This keeps the stub the
 * zero-config default so a fresh checkout can dispatch immediately.
 */
export function createWhatsAppProvider(
  env: Record<string, string | undefined>,
): WhatsAppProvider {
  const selected = (env.WHATSAPP_PROVIDER ?? "stub").toLowerCase();

  switch (selected) {
    case "aisensy": {
      if (env.AISENSY_API_KEY) {
        return new AiSensyWhatsAppProvider({
          apiKey: env.AISENSY_API_KEY,
          campaignName: env.AISENSY_CAMPAIGN_NAME,
          userName: env.AISENSY_USER_NAME,
          apiUrl: env.AISENSY_API_URL,
        });
      }
      console.warn("[dispatch] WHATSAPP_PROVIDER=aisensy but AISENSY_API_KEY missing; using stub");
      return new StubWhatsAppProvider();
    }
    case "gupshup": {
      if (env.GUPSHUP_API_KEY && env.GUPSHUP_SOURCE) {
        return new GupshupWhatsAppProvider({
          apiKey: env.GUPSHUP_API_KEY,
          source: env.GUPSHUP_SOURCE,
          appName: env.GUPSHUP_APP_NAME,
          apiUrl: env.GUPSHUP_API_URL,
        });
      }
      console.warn(
        "[dispatch] WHATSAPP_PROVIDER=gupshup but GUPSHUP_API_KEY/GUPSHUP_SOURCE missing; using stub",
      );
      return new StubWhatsAppProvider();
    }
    case "stub":
      return new StubWhatsAppProvider();
    default:
      console.warn(`[dispatch] unknown WHATSAPP_PROVIDER="${selected}"; using stub`);
      return new StubWhatsAppProvider();
  }
}
