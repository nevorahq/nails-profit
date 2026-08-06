import { getNotificationProviderName, getResendConfig } from "@/env";
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
  /** Non-PII routing metadata echoed by Resend in signed webhook events. */
  tags?: readonly Readonly<{ name: string; value: string }>[];
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

type ResendError = Readonly<{ name?: unknown }>;

function resendErrorCode(body: ResendError | null, status: number) {
  const name = typeof body?.name === "string" ? body.name : `http_${status}`;
  return `resend_${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}`;
}

function resendFailureIsRetryable(status: number, body: ResendError | null) {
  if (body?.name === "concurrent_idempotent_requests") return true;
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Resend's REST adapter. Kept behind the existing provider interface so the
 * transactional outbox, retry schedule and dead-letter policy remain the
 * source of truth. Resend receives the same logical idempotency key on every
 * attempt; it retains those keys for 24 hours while our outbox prevents a
 * logical send from being recreated later.
 */
export function createResendNotificationProvider(
  config: Readonly<{ apiKey: string; from: string }>,
  fetchImpl: typeof fetch = fetch,
): NotificationProvider {
  return {
    name: "resend",
    async send(message) {
      if (message.channel !== "email") {
        return { ok: false, code: "resend_unsupported_channel", retryable: false };
      }

      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": message.idempotencyKey,
          "user-agent": "nail-profit-os/0.1",
        },
        body: JSON.stringify({
          from: config.from,
          to: [message.destination],
          subject: message.subject,
          text: message.body,
          ...(message.tags ? { tags: message.tags } : {}),
        }),
      });

      const body = (await response.json().catch(() => null)) as
        | Readonly<{ id?: unknown; name?: unknown }>
        | null;
      if (response.ok) {
        return typeof body?.id === "string" && body.id.length > 0
          ? { ok: true, providerMessageId: body.id }
          : { ok: false, code: "resend_invalid_response", retryable: true };
      }

      return {
        ok: false,
        code: resendErrorCode(body, response.status),
        retryable: resendFailureIsRetryable(response.status, body),
      };
    },
  };
}

let override: NotificationProvider | null = null;

/** Tests install a provider that fails on purpose; nothing else calls this. */
export function setNotificationProvider(provider: NotificationProvider | null) {
  override = provider;
}

export function notificationProvider(): NotificationProvider {
  if (override) return override;
  return getNotificationProviderName() === "resend"
    ? createResendNotificationProvider(getResendConfig())
    : logNotificationProvider;
}
