import type { DispatchChannel } from "@pebble/shared";
import type { EmailMessage, EmailProvider } from "./email";
import { DEFAULT_EMAIL_FROM } from "./email";
import type { DispatchAttachment, SendResult } from "./types";
import { isUrlAttachment } from "./types";
import type { WhatsAppMessage, WhatsAppProvider } from "./whatsapp";

/**
 * Dispatch orchestration (spec 4.7 — "one dispatch action fans out email +
 * WhatsApp with the same GCS artifacts"). This layer is pure with respect to
 * persistence: the outbox `dispatches` rows and audit intents are written by
 * the caller/worker. Here we only translate one estimate-dispatch request into
 * per-channel sends and collect their `SendResult`s.
 */

export interface DispatchProviders {
  /** Omit to skip the email channel entirely. */
  email?: EmailProvider;
  /** Omit to skip the WhatsApp channel entirely. */
  whatsapp?: WhatsAppProvider;
}

export interface EstimateDispatchRequest {
  /** Email recipient(s). Omit (or leave `providers.email` unset) to skip email. */
  toEmail?: string | string[];
  /** WhatsApp recipient MSISDN. Omit (or leave `providers.whatsapp` unset) to skip WhatsApp. */
  toPhone?: string;
  /** Email subject line. */
  subject: string;
  /** Body text — used as the email text part and the WhatsApp body. */
  message: string;
  /** Optional rich HTML body for the email (falls back to `message`). */
  html?: string;
  /** Email sender override; defaults to the Greenberg verified address. */
  from?: string;
  /** Email reply-to override. */
  replyTo?: string;
  /**
   * Shared artifacts (branded PDF / Excel). Emailed as attachments; the first
   * URL-based artifact doubles as the WhatsApp media so both channels reference
   * the same GCS object.
   */
  attachments?: DispatchAttachment[];
  /** Approved WhatsApp template name for business-initiated sends. */
  whatsAppTemplate?: string;
  /** WhatsApp template variables, keyed by position. */
  whatsAppVariables?: Record<string, string>;
  /** Explicit WhatsApp media URL (overrides the derived artifact URL). */
  whatsAppMediaUrl?: string;
}

/** One channel's outcome within a fan-out. */
export interface ChannelDispatchResult {
  channel: DispatchChannel;
  result: SendResult;
}

/** First URL-based artifact, if any — the natural WhatsApp media reference. */
function firstArtifactUrl(attachments: DispatchAttachment[] | undefined): string | undefined {
  return attachments?.find(isUrlAttachment)?.url;
}

/**
 * Fan a single dispatch request out to every requested-and-available channel
 * and return one result per channel that actually sent. A channel fires only
 * when both its provider is supplied AND the request names a recipient for it,
 * so callers can dispatch email-only, WhatsApp-only, or both from one shape.
 *
 * Channels are sent concurrently; results come back in a stable EMAIL-then-
 * WHATSAPP order so the outbox writes deterministic `dispatches` rows.
 */
export async function dispatchEstimate(
  providers: DispatchProviders,
  request: EstimateDispatchRequest,
): Promise<ChannelDispatchResult[]> {
  const pending: Array<Promise<ChannelDispatchResult>> = [];

  if (providers.email && request.toEmail) {
    const emailMsg: EmailMessage = {
      to: request.toEmail,
      from: request.from ?? DEFAULT_EMAIL_FROM,
      subject: request.subject,
      html: request.html ?? undefined,
      text: request.message,
      ...(request.replyTo ? { replyTo: request.replyTo } : {}),
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
    };
    pending.push(
      providers.email
        .send(emailMsg)
        .then((result) => ({ channel: "EMAIL" as DispatchChannel, result })),
    );
  }

  if (providers.whatsapp && request.toPhone) {
    const waMsg: WhatsAppMessage = {
      to: request.toPhone,
      bodyText: request.message,
      ...(request.whatsAppTemplate ? { templateName: request.whatsAppTemplate } : {}),
      ...(request.whatsAppVariables ? { variables: request.whatsAppVariables } : {}),
    };
    const mediaUrl = request.whatsAppMediaUrl ?? firstArtifactUrl(request.attachments);
    if (mediaUrl) waMsg.mediaUrl = mediaUrl;
    pending.push(
      providers.whatsapp
        .send(waMsg)
        .then((result) => ({ channel: "WHATSAPP" as DispatchChannel, result })),
    );
  }

  return Promise.all(pending);
}
