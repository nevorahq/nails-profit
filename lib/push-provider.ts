import webpush from "web-push";

import { withTenant } from "@/db/tenant";
import { getVapidConfig } from "@/env";
import { logEvent } from "@/lib/logger";
import type { DeliveryResult, NotificationProvider, OutgoingMessage } from "@/lib/notification-provider";
import { forgetDeviceById, touchDevice } from "@/lib/push-subscriptions";

/**
 * Web push through each browser's own push service, phase 7.
 *
 * Behind the same interface as Resend and sms.md, so a push inherits the
 * outbox's retries, its idempotency and its dead letters rather than a second
 * set of its own. What is particular to push is one answer: 404 or 410 means
 * the device is gone — uninstalled, signed out of the browser, permission taken
 * back — and will never come back under that endpoint. The row is forgotten
 * there and then, so nothing is ever sent to it again.
 */

type SendResult = Readonly<{ statusCode: number; headers?: Record<string, string> }>;

export type PushDependencies = Readonly<{
  vapid: Readonly<{ publicKey: string; privateKey: string; subject: string }>;
  send: (
    subscription: Readonly<{ endpoint: string; keys: Readonly<{ p256dh: string; auth: string }> }>,
    payload: string,
    options: webpush.RequestOptions,
  ) => Promise<SendResult>;
  /** A device the push service no longer knows. */
  forget: (organizationId: string, subscriptionId: string) => Promise<void>;
  /** A device that just took a push: the last time it was known to work. */
  touch: (organizationId: string, subscriptionId: string) => Promise<void>;
}>;

/**
 * Long enough for a phone in a drawer to wake and still be told, short enough
 * that a request answered in the meantime is not announced the next morning.
 * The dispatcher re-checks that before sending; this covers the push service
 * holding it afterwards.
 */
const TIME_TO_LIVE_SECONDS = 6 * 60 * 60;

function statusOf(error: unknown): number | null {
  const code = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : null;
}

export function createWebPushProvider(deps: PushDependencies): NotificationProvider {
  return {
    name: "webpush",
    async send(message: OutgoingMessage): Promise<DeliveryResult> {
      if (message.channel !== "push" || !message.push) {
        return { ok: false, code: "webpush_unsupported_channel", retryable: false };
      }
      const device = message.push;

      let status: number | null;
      try {
        const result = await deps.send(
          { endpoint: message.destination, keys: { p256dh: device.p256dh, auth: device.auth } },
          message.body,
          {
            vapidDetails: deps.vapid,
            TTL: TIME_TO_LIVE_SECONDS,
            // A request is time-bound: a phone in power saving should still wake.
            urgency: "high",
            timeout: 10_000,
          },
        );
        status = result.statusCode;
      } catch (error) {
        status = statusOf(error);
        if (status === null) {
          // No answer at all — DNS, a reset, the timeout. Worth another go.
          return { ok: false, code: "webpush_unreachable", retryable: true };
        }
      }

      if (status >= 200 && status < 300) {
        await deps.touch(device.organizationId, device.subscriptionId).catch(() => undefined);
        return { ok: true, providerMessageId: `push:${message.idempotencyKey}` };
      }

      if (status === 404 || status === 410) {
        await deps.forget(device.organizationId, device.subscriptionId);
        logEvent(
          "info",
          "push.subscription_gone",
          { organizationId: device.organizationId },
          // The host says which push service; the path would address the phone.
          { push_service: new URL(message.destination).host, status },
        );
        return { ok: false, code: "webpush_gone", retryable: false };
      }

      return {
        ok: false,
        code: `webpush_http_${status}`,
        // 403 is our key not matching the one the device subscribed with, 413 a
        // payload too large: neither changes on a retry. A busy or failing push
        // service does.
        retryable: status === 408 || status === 429 || status >= 500,
      };
    },
  };
}

/** The provider the dispatcher uses: real keys, real push services, real rows. */
export function pushNotificationProvider(): NotificationProvider {
  const vapid = getVapidConfig();
  if (!vapid) {
    return {
      name: "webpush",
      // Rows written while keys were set and drained after they were removed.
      send: async () => ({ ok: false, code: "webpush_not_configured", retryable: false }),
    };
  }

  return createWebPushProvider({
    vapid,
    send: (subscription, payload, options) =>
      webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { ...subscription.keys } },
        payload,
        options,
      ),
    forget: (organizationId, subscriptionId) =>
      withTenant(organizationId, (tx) => forgetDeviceById(tx, subscriptionId)),
    touch: (organizationId, subscriptionId) =>
      withTenant(organizationId, (tx) => touchDevice(tx, subscriptionId, new Date())),
  });
}
