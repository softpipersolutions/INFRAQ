import type { CreateEmailOptions, Attachment as ResendAttachment } from "resend";
import { Resend } from "resend";
import type { DispatchAttachment, SendResult } from "./types";
import { isUrlAttachment } from "./types";

/**
 * Email channel (spec 4.7 — Resend). Two implementations behind one interface:
 * a real `ResendEmailProvider` and a network-free `StubEmailProvider` that lets
 * the whole dispatch flow demo (and CI) run with zero credentials. Selection is
 * env-driven via `createEmailProvider`.
 */

/** Greenberg's default sender — a verified domain address on the Resend account. */
export const DEFAULT_EMAIL_FROM = "Greenberg Estimates <estimates@greenberg.example>";

export interface EmailMessage {
  to: string | string[];
  from: string;
  subject: string;
  html?: string;
  text?: string;
  attachments?: DispatchAttachment[];
  replyTo?: string;
}

export interface EmailProvider {
  /** Attempt to send `msg`. Never throws — transport errors map to a FAILED result. */
  send(msg: EmailMessage): Promise<SendResult>;
}

/**
 * Map our transport-agnostic attachment onto Resend's `{ filename, content }`
 * (inline bytes) or `{ filename, path }` (remote URL Resend fetches). Bytes are
 * normalised to a Buffer; Resend also accepts a base64 string, but a Buffer
 * avoids an extra copy for the common freshly-rendered-PDF case.
 */
function toResendAttachment(att: DispatchAttachment): ResendAttachment {
  if (isUrlAttachment(att)) {
    return { filename: att.filename, path: att.url, contentType: att.contentType };
  }
  const content =
    typeof att.content === "string" || Buffer.isBuffer(att.content)
      ? att.content
      : Buffer.from(att.content);
  return { filename: att.filename, content, contentType: att.contentType };
}

/**
 * Production email adapter. Constructs the Resend client eagerly (cheap — the
 * SDK holds the key, it does NOT open a connection or validate the key until a
 * send), so building one is side-effect-free and safe in the factory.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly provider = "resend";
  private readonly client: Resend;
  readonly defaultFrom: string;

  constructor(apiKey: string, defaultFrom: string = DEFAULT_EMAIL_FROM) {
    this.client = new Resend(apiKey);
    this.defaultFrom = defaultFrom;
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    // Resend's typed payload requires at least one of html/text/react; we build
    // the fields we actually have and cast to satisfy that "one of" constraint.
    const payload = {
      from: msg.from || this.defaultFrom,
      to: msg.to,
      subject: msg.subject,
      ...(msg.html ? { html: msg.html } : {}),
      ...(msg.text ? { text: msg.text } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      ...(msg.attachments?.length
        ? { attachments: msg.attachments.map(toResendAttachment) }
        : {}),
    } as CreateEmailOptions;

    try {
      const { data, error } = await this.client.emails.send(payload);
      if (error) {
        return {
          ok: false,
          status: "FAILED",
          providerMessageId: null,
          error: error.message,
          provider: this.provider,
        };
      }
      return {
        ok: true,
        status: "SENT",
        providerMessageId: data?.id ?? null,
        error: null,
        provider: this.provider,
      };
    } catch (err) {
      return {
        ok: false,
        status: "FAILED",
        providerMessageId: null,
        error: err instanceof Error ? err.message : String(err),
        provider: this.provider,
      };
    }
  }
}

/**
 * In-memory email adapter for tests, local dev, and demos. Records every sent
 * message on `.sent` (assertable) and reports SENT with a deterministic
 * `stub-email-<n>` id. Makes no network calls and needs no API key.
 */
export class StubEmailProvider implements EmailProvider {
  readonly provider = "stub";
  readonly defaultFrom: string;
  /** Every message handed to `send`, in call order. */
  readonly sent: EmailMessage[] = [];

  constructor(defaultFrom: string = DEFAULT_EMAIL_FROM) {
    this.defaultFrom = defaultFrom;
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    this.sent.push(msg);
    return {
      ok: true,
      status: "SENT",
      providerMessageId: `stub-email-${this.sent.length}`,
      error: null,
      provider: this.provider,
    };
  }
}

/**
 * Pick an email adapter from the environment. Real Resend when `RESEND_API_KEY`
 * is present; otherwise the stub, so the app is fully functional with no
 * secrets configured (the Phase-3 demo path). The sender defaults to
 * `DISPATCH_EMAIL_FROM`, then Greenberg's verified address.
 */
export function createEmailProvider(
  env: Record<string, string | undefined>,
): EmailProvider {
  const from = env.DISPATCH_EMAIL_FROM || DEFAULT_EMAIL_FROM;
  const apiKey = env.RESEND_API_KEY;
  if (apiKey) {
    return new ResendEmailProvider(apiKey, from);
  }
  return new StubEmailProvider(from);
}
