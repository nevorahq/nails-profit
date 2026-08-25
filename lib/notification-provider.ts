import { getMessaggioConfig, getNotificationProviderName, getResendConfig, getSmsProviderName } from "@/env";
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

const MESSAGGIO_ENDPOINT = "https://msg.messaggio.com/api/v1/send";

/**
 * Messaggio has no tags/metadata field on a message — only the free-text
 * `options.external_id`, which its documentation describes as "used to
 * identify messages by the user in the system and transmitted together with
 * the delivery status." The outbox row's own identity is packed into it here
 * and unpacked by `lib/messaggio-webhook.ts`. Colon-joined rather than JSON:
 * the field is meant for a short reference string.
 */
export function messaggioExternalId(message: OutgoingMessage): string {
  const organizationId = message.tags?.find((tag) => tag.name === "organization_id")?.value;
  const notificationId = message.tags?.find((tag) => tag.name === "notification_id")?.value;
  return organizationId && notificationId
    ? `${organizationId}:${notificationId}`
    : message.idempotencyKey;
}

/** The inverse of `messaggioExternalId` — null for anything not in that shape. */
export function parseMessaggioExternalId(
  value: string,
): Readonly<{ organizationId: string; notificationId: string }> | null {
  const [organizationId, notificationId] = value.split(":");
  return organizationId && notificationId ? { organizationId, notificationId } : null;
}

/** A code and a title/detail pair — the shape of both a top-level and a per-recipient failure. */
function messaggioFailureCode(title: string | undefined, fallback: string) {
  return `messaggio_${(title ?? fallback).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

/**
 * Messaggio's multichannel API (`msg.messaggio.com`), roadmap section 7.7's
 * second channel: SMS to Moldovan numbers at Moldcell/Orange/Unité rates.
 * JSON over HTTPS like this codebase's other providers, authenticated by a
 * single `Messaggio-Login` header — its documentation shows no separate
 * signing secret, so there is none to compute here.
 *
 * `phone` in the outgoing request is digits only, no leading "+"; `destination`
 * on `OutgoingMessage` carries it in E.164 form (`domain/phone.ts`), so the one
 * translation this adapter owns is stripping that "+".
 */
export function createMessaggioNotificationProvider(
  config: Readonly<{ login: string; from: string }>,
  fetchImpl: typeof fetch = fetch,
): NotificationProvider {
  return {
    name: "messaggio",
    async send(message) {
      if (message.channel !== "sms") {
        return { ok: false, code: "messaggio_unsupported_channel", retryable: false };
      }

      const phone = message.destination.replace(/^\+/, "");

      const response = await fetchImpl(MESSAGGIO_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "messaggio-login": config.login,
        },
        body: JSON.stringify({
          recipients: [{ phone }],
          channels: ["sms"],
          options: { external_id: messaggioExternalId(message) },
          sms: { from: config.from, content: [{ type: "text", text: message.body }] },
        }),
      });

      // 400/403/422 are this request being wrong in a way retrying will not
      // fix; 500 is the one status the documentation itself asks the caller
      // to repeat.
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | Readonly<{ title?: string }>
          | null;
        return {
          ok: false,
          code: messaggioFailureCode(body?.title, `http_${response.status}`),
          retryable: response.status === 500,
        };
      }

      const body = (await response.json().catch(() => null)) as
        | Readonly<{
            messages?: readonly Readonly<{
              message_id?: string;
              error?: Readonly<{ title?: string }>;
            }>[];
          }>
        | null;
      const sent = body?.messages?.[0];
      if (!sent) return { ok: false, code: "messaggio_invalid_response", retryable: true };

      // A 200 with a per-recipient error is what an invalid phone number looks
      // like: the request itself was fine, this one recipient was not.
      if (sent.error) {
        return { ok: false, code: messaggioFailureCode(sent.error.title, "recipient_error"), retryable: false };
      }

      return sent.message_id
        ? { ok: true, providerMessageId: sent.message_id }
        : { ok: false, code: "messaggio_missing_message_id", retryable: true };
    },
  };
}

let override: NotificationProvider | null = null;

/** Tests install a provider that fails on purpose; nothing else calls this. */
export function setNotificationProvider(provider: NotificationProvider | null) {
  override = provider;
}

/**
 * Email and SMS are chosen independently — `NOTIFICATION_PROVIDER` picks the
 * email adapter, `SMS_PROVIDER` picks the SMS one — so finishing SMS
 * onboarding can never silently change what sends the emails already in
 * production, and vice versa.
 */
export function notificationProvider(channel: "email" | "sms"): NotificationProvider {
  if (override) return override;

  if (channel === "sms") {
    return getSmsProviderName() === "messaggio"
      ? createMessaggioNotificationProvider(getMessaggioConfig())
      : logNotificationProvider;
  }

  return getNotificationProviderName() === "resend"
    ? createResendNotificationProvider(getResendConfig())
    : logNotificationProvider;
}
