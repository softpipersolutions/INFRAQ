/**
 * @pebble/dispatch — outbox dispatch adapters for Module 02 (spec 4.7).
 *
 * Email over Resend and WhatsApp over a pluggable provider (AiSensy / Gupshup /
 * Stub), all producing a uniform `SendResult` so the outbox worker persists one
 * shape regardless of channel or vendor. Nothing here touches the database:
 * this package only sends; the caller writes `dispatches` rows + audit intents.
 */

export type { DispatchAttachment, SendResult } from "./types";
export { isUrlAttachment } from "./types";

export type { EmailMessage, EmailProvider } from "./email";
export {
  DEFAULT_EMAIL_FROM,
  ResendEmailProvider,
  StubEmailProvider,
  createEmailProvider,
} from "./email";

export type {
  AiSensyConfig,
  GupshupConfig,
  WhatsAppMessage,
  WhatsAppProvider,
} from "./whatsapp";
export {
  AiSensyWhatsAppProvider,
  GupshupWhatsAppProvider,
  StubWhatsAppProvider,
  createWhatsAppProvider,
} from "./whatsapp";

export type {
  ChannelDispatchResult,
  DispatchProviders,
  EstimateDispatchRequest,
} from "./dispatch";
export { dispatchEstimate } from "./dispatch";
