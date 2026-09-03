import {
  getNotificationProviderName,
  getResendConfig,
  getSmsMdConfig,
  getSmsProviderName,
} from "@/env";
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
  /**
   * The email's HTML alternative, sent beside `body` rather than instead of
   * it: a client that will not render HTML — or a filter that strips it — is
   * left with the same message in plain text.
   */
  html?: string;
  /**
   * Who the message appears to be from, for the reader: the studio's own name,
   * not the product's. Only the display part of the address — the mailbox and
   * its domain stay the verified ones, because those are what the signature is
   * checked against. SMS has no equivalent: its sender is one operator-approved
   * alias for the whole account.
   */
  fromName?: string;
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
    return { ok: true, providerMessageId: `${LOGGED_MESSAGE_ID_PREFIX}${message.idempotencyKey}` };
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
 * The `From` header, with the studio's name in front of the configured
 * address.
 *
 * Only the display name changes. The mailbox and its domain are what Resend
 * verified and what SPF/DKIM sign, so they come from `RESEND_FROM` and are
 * never built from tenant data — a studio that could choose its own sending
 * domain could send as anyone.
 *
 * The name is quoted rather than trusted: `\r\n` typed into a studio's name
 * would otherwise end the header and start one of the sender's choosing, and a
 * bare comma or dot would be read as address syntax. Non-ASCII stays as it is
 * — Resend encodes the header itself, and encoding it twice is what turns a
 * Cyrillic studio name into mojibake.
 */
function resendFrom(configured: string, fromName?: string): string {
  if (!fromName) return configured;

  const display = fromName.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/["\\]/g, "").trim().slice(0, 64);
  if (display === "") return configured;

  const address = /<([^>]+)>/.exec(configured)?.[1]?.trim() ?? configured.trim();
  return `"${display}" <${address}>`;
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
          from: resendFrom(config.from, message.fromName),
          to: [message.destination],
          subject: message.subject,
          text: message.body,
          ...(message.html ? { html: message.html } : {}),
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

/** Shared by the adapter below and the delivery-status poll that reads it back. */
export const SMSMD_API_BASE = "https://api.sms.md/v3";

/**
 * The namespace the `log` provider mints its message ids in.
 *
 * It is not a provider's id and no provider will recognise it, which is the
 * whole point — and the reason it has a name rather than being spelled inline.
 * The delivery poller reads message ids back and asks sms.md about them, so a
 * fake one that looks real is a stream of 404s against somebody's account: see
 * `pollSmsMdDeliveryStatuses`, which filters on exactly this prefix.
 */
export const LOGGED_MESSAGE_ID_PREFIX = "log:";

/**
 * Error codes this API answers with (`ApiError.code` in its OpenAPI document)
 * that another attempt could still get past. `INSUFFICIENT_BALANCE` is in the
 * list on purpose: it is not the request being wrong, it is the account being
 * empty, and dead-lettering every client's message on the morning a top-up is
 * late would throw away messages that a retry an hour later delivers. What is
 * left out is the request itself being unacceptable — a bad token, a missing
 * scope, a sender name or number the platform rejects — which no number of
 * attempts changes.
 */
const SMSMD_RETRYABLE_CODES = new Set(["INSUFFICIENT_BALANCE", "RATE_LIMIT_EXCEEDED", "INTERNAL_ERROR"]);

function smsMdFailureCode(code: string | undefined, status: number) {
  const name = code ?? `http_${status}`;
  return `smsmd_${name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 80)}`;
}

/**
 * sms.md's v3 API (`api.sms.md`), the platform this pilot sends its Moldovan
 * SMS through: JSON over HTTPS, authenticated by a single `X-Api-Token`
 * header issued in Settings → API.
 *
 * `to` is handed over exactly as the client record stores it. E.164
 * (`+37369123456`) is one of the forms the API documents as accepted, so there
 * is no format to translate here — and a translation is a thing that can be
 * wrong.
 *
 * What this API does not have, and Resend on the email side does, is anywhere
 * to put an idempotency key: `POST /v3/messages` takes `from`, `to`, `text`
 * and `sendAt`, nothing else, and it charges the balance the moment it queues
 * the message. So a request that times out after the platform accepted it and
 * is then retried sends — and bills — a second SMS. The outbox still prevents
 * a *logical* send from being recreated, which bounds this to the one case of
 * a provider call whose answer was lost in flight; there is no field here that
 * would let the provider recognise the retry, and pretending otherwise by
 * packing an id into the message text would put it in front of the client.
 */
export function createSmsMdNotificationProvider(
  config: Readonly<{ token: string; from: string }>,
  fetchImpl: typeof fetch = fetch,
): NotificationProvider {
  return {
    name: "smsmd",
    async send(message) {
      if (message.channel !== "sms") {
        return { ok: false, code: "smsmd_unsupported_channel", retryable: false };
      }

      const response = await fetchImpl(`${SMSMD_API_BASE}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-token": config.token,
        },
        body: JSON.stringify({
          from: config.from,
          to: message.destination,
          text: message.body,
        }),
      });

      const body = (await response.json().catch(() => null)) as
        | Readonly<{ code?: string; data?: Readonly<{ id?: unknown }> }>
        | null;

      if (!response.ok) {
        const code = typeof body?.code === "string" ? body.code : undefined;
        return {
          ok: false,
          code: smsMdFailureCode(code, response.status),
          // A 5xx with no readable body is still the platform failing rather
          // than the request being wrong.
          retryable: code ? SMSMD_RETRYABLE_CODES.has(code) : response.status >= 500,
        };
      }

      const id = body?.data?.id;
      return typeof id === "string" && id.length > 0
        ? { ok: true, providerMessageId: id }
        : { ok: false, code: "smsmd_invalid_response", retryable: true };
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
    return getSmsProviderName() === "smsmd"
      ? createSmsMdNotificationProvider(getSmsMdConfig())
      : logNotificationProvider;
  }

  return getNotificationProviderName() === "resend"
    ? createResendNotificationProvider(getResendConfig())
    : logNotificationProvider;
}
