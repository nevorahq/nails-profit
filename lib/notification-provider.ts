import { getNotificationProviderName } from "@/env";
import { logEvent } from "@/lib/logger";

/**
 * The seam a transactional provider plugs into, roadmap section 7.7.
 *
 * Entry Gate 7 asks for a provider to be *chosen* before the phase starts;
 * nothing in the queue, the retry policy or the templates depends on which one
 * it turns out to be. Keeping that decision behind one interface is what lets
 * the rest of 7.4 be finished, tested and reviewed while the contract is still
 * being negotiated — and what makes the eventual adapter a file to add rather
 * than a change to make everywhere.
 *
 * The distinction that matters to the dispatcher is not which error happened
 * but whether repeating the request could ever help: a provider timeout is
 * worth another attempt, an address the provider rejects is not.
 */
export type OutgoingMessage = Readonly<{
  channel: "email" | "sms";
  destination: string;
  subject: string;
  body: string;
  /** Handed to the provider so its own deduplication sees a retry as a retry. */
  idempotencyKey: string;
}>;

export type DeliveryResult =
  | Readonly<{ ok: true; providerMessageId: string }>
  | Readonly<{ ok: false; code: string; retryable: boolean }>;

export type NotificationProvider = Readonly<{
  name: string;
  send: (message: OutgoingMessage) => Promise<DeliveryResult>;
}>;

/**
 * The pilot's provider: it writes the line a provider would have sent and
 * reports the delivery.
 *
 * Honest rather than convenient — it does not pretend a message reached a
 * phone, it records that the system decided to send one. That is enough to
 * measure section 7.10's queue depth and delivery rate on the pilot, and it
 * keeps every other part of the path exercised for real.
 */
export const logNotificationProvider: NotificationProvider = {
  name: "log",
  async send(message) {
    logEvent(
      "info",
      "notification.delivered",
      {},
      {
        channel: message.channel,
        // Named so the logger's own redaction masks it: section 7.9 keeps
        // contact details out of logs, including this one.
        [message.channel === "sms" ? "recipient_phone" : "recipient_email"]: message.destination,
        idempotency_key: message.idempotencyKey,
        body_length: message.body.length,
      },
    );
    return { ok: true, providerMessageId: `log:${message.idempotencyKey}` };
  },
};

let override: NotificationProvider | null = null;

/** Tests install a provider that fails on purpose; nothing else calls this. */
export function setNotificationProvider(provider: NotificationProvider | null) {
  override = provider;
}

export function notificationProvider(): NotificationProvider {
  if (override) return override;
  getNotificationProviderName();
  return logNotificationProvider;
}
