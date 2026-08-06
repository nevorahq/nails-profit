import { Webhook } from "svix";

export type ResendWebhookHeaders = Readonly<{
  "svix-id": string;
  "svix-timestamp": string;
  "svix-signature": string;
}>;

/** Signature verification deliberately receives the untouched request text. */
export function verifyResendWebhook(
  rawBody: string,
  headers: ResendWebhookHeaders,
  secret: string,
) {
  return new Webhook(secret).verify(rawBody, headers);
}
