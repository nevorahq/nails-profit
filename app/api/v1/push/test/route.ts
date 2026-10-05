import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { organizations, pushSubscriptions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { getVapidConfig } from "@/env";
import type { AppLocale } from "@/i18n/messages";
import { supportedLocales } from "@/i18n/messages";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { notificationProvider } from "@/lib/notification-provider";
import { deviceSchema, pushCaller } from "@/lib/push-http";
import { renderTestPush } from "@/lib/push-message";
import { PUSH_TEST_RULE } from "@/lib/rate-limit";

/**
 * «Проверить»: a real push to the device the button was pressed on, now.
 *
 * Sent directly rather than through the outbox. The outbox is for messages
 * about appointments and has no row for one about nothing, and what the person
 * needs is the answer while they are still holding the phone — «пришло» or
 * «не пришло, и вот почему» — not a row that drains in five minutes.
 *
 * Only to the caller's own device, found by endpoint among their own rows: a
 * test cannot be aimed at a colleague's phone, and an endpoint that is not a
 * subscription of theirs is a 404 rather than a request to an arbitrary URL.
 */
export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await pushCaller(request, id, PUSH_TEST_RULE, "push.test");
  if (!caller.ok) return caller.response;
  const { actor } = caller;

  if (!getVapidConfig()) {
    return apiError(503, "PUSH_DISABLED", "Push notifications are not configured here", id);
  }

  const parsed = deviceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const [device] = await withTenant(actor.organizationId, (tx) =>
    tx
      .select()
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, actor.userId),
          eq(pushSubscriptions.endpoint, parsed.data.endpoint),
        ),
      )
      .limit(1),
  );
  if (!device) {
    return apiError(404, "PUSH_DEVICE_NOT_FOUND", "This device is not subscribed", id);
  }

  const [organization] = await db
    .select({ locale: organizations.locale })
    .from(organizations)
    .where(eq(organizations.id, actor.organizationId))
    .limit(1);
  const locale = (supportedLocales as readonly string[]).includes(organization?.locale ?? "")
    ? (organization!.locale as AppLocale)
    : "ru";

  const payload = renderTestPush(locale);
  const result = await notificationProvider("push").send({
    channel: "push",
    destination: device.endpoint,
    subject: payload.title,
    body: JSON.stringify(payload),
    idempotencyKey: `test:${device.id}:${Date.now()}`,
    push: {
      organizationId: actor.organizationId,
      subscriptionId: device.id,
      p256dh: device.p256dh,
      auth: device.auth,
    },
  });

  if (result.ok) return apiSuccess({ sent: true }, id);
  if (result.code === "webpush_gone") {
    // Already forgotten by the provider; the switch offers to turn it on again.
    return apiError(410, "PUSH_DEVICE_GONE", "The push service no longer knows this device", id);
  }
  return apiError(502, "PUSH_FAILED", "The push service did not accept the notification", id, {
    details: { code: result.code },
  });
}
