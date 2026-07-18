import type { DispatchStatus } from "@pebble/shared";

/**
 * Cross-channel dispatch contracts (spec 4.7). Kept deliberately transport- and
 * vendor-agnostic: email (Resend) and every WhatsApp provider produce the same
 * `SendResult`, so the outbox worker can persist a `dispatches` row from one
 * shape regardless of which adapter actually sent the message.
 */

/**
 * A single artifact rendered alongside a dispatch (branded PDF / Excel).
 *
 * Two carriers are supported because our artifacts live in GCS: inline bytes
 * (`content`) for small payloads and freshly generated files, or a signed
 * `url` for large objects we'd rather not buffer into memory. Email attaches
 * both kinds; WhatsApp can only reference a URL (it has no byte-upload here),
 * so URL-based artifacts double as WhatsApp media.
 */
export type DispatchAttachment =
  | {
      filename: string;
      /** Inline bytes. `Uint8Array` is normalised to a Buffer by adapters. */
      content: Buffer | Uint8Array | string;
      contentType?: string;
      url?: never;
    }
  | {
      filename: string;
      /** Pre-signed URL the provider fetches the bytes from. */
      url: string;
      contentType?: string;
      content?: never;
    };

/** Narrowing helper — `true` when the attachment carries a URL, not bytes. */
export function isUrlAttachment(
  att: DispatchAttachment,
): att is Extract<DispatchAttachment, { url: string }> {
  return typeof (att as { url?: unknown }).url === "string";
}

/**
 * Normalised outcome of one provider send. `status` is the canonical
 * `DispatchStatus` the outbox persists; providers only ever return QUEUED /
 * SENT / FAILED here — DELIVERED arrives later via provider webhooks, out of
 * this package's scope. `provider` is the adapter tag (e.g. "resend", "stub",
 * "aisensy") for diagnostics and per-vendor metrics.
 */
export interface SendResult {
  ok: boolean;
  status: DispatchStatus;
  /** Vendor's message id, when the send was accepted. */
  providerMessageId?: string | null;
  /** Human-readable failure reason when `ok` is false. */
  error?: string | null;
  provider: string;
}
