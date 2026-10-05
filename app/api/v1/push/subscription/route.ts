import { withTenant } from "@/db/tenant";
import { getVapidConfig } from "@/env";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { logEvent } from "@/lib/logger";
import { deviceSchema, pushCaller, subscriptionSchema } from "@/lib/push-http";
import { deviceCountOf, forgetDevice, saveDevice } from "@/lib/push-subscriptions";
import { PUSH_SUBSCRIPTION_RULE } from "@/lib/rate-limit";

/**
 * «Уведомления на этом устройстве», phase 7.
 *
 * GET tells the switch whether push exists here at all and which key a browser
 * must subscribe with; PUT and DELETE are the switch. The device is named by
 * its endpoint in the body, never in the address: the endpoint is a capability
 * URL, and addresses end up in logs and histories.
 */
export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await pushCaller(request, id, null, "push.subscription");
  if (!caller.ok) return caller.response;

  const vapid = getVapidConfig();
  const devices = await withTenant(caller.actor.organizationId, (tx) =>
    deviceCountOf(tx, caller.actor.userId),
  );

  return apiSuccess(
    { enabled: vapid !== null, public_key: vapid?.publicKey ?? null, devices },
    id,
  );
}

export async function PUT(request: Request) {
  const id = requestId(request);
  const caller = await pushCaller(request, id, PUSH_SUBSCRIPTION_RULE, "push.subscription");
  if (!caller.ok) return caller.response;
  const { actor } = caller;

  if (!getVapidConfig()) {
    return apiError(503, "PUSH_DISABLED", "Push notifications are not configured here", id);
  }

  const parsed = subscriptionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const outcome = await withTenant(actor.organizationId, (tx) =>
    saveDevice(tx, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      device: {
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
      },
    }),
  );

  if (outcome === "taken") {
    /*
     * Another studio's device, by its endpoint. The browser can mint a new one
     * by unsubscribing and subscribing again, and the switch does exactly that
     * on this answer; the old endpoint then dies at the push service and the
     * other studio's row is cleared the first time it is sent to.
     */
    return apiError(409, "PUSH_DEVICE_TAKEN", "This device is registered to another studio", id);
  }

  // The host only: the path of an endpoint is what addresses the device.
  logEvent(
    "info",
    "push.subscribed",
    { requestId: id, organizationId: actor.organizationId, userId: actor.userId },
    { push_service: new URL(parsed.data.endpoint).host },
  );
  return apiSuccess({ subscribed: true }, id);
}

export async function DELETE(request: Request) {
  const id = requestId(request);
  const caller = await pushCaller(request, id, PUSH_SUBSCRIPTION_RULE, "push.subscription");
  if (!caller.ok) return caller.response;
  const { actor } = caller;

  const parsed = deviceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  // Idempotent: a device already forgotten is the answer the caller wanted.
  const removed = await withTenant(actor.organizationId, (tx) =>
    forgetDevice(tx, { userId: actor.userId, endpoint: parsed.data.endpoint }),
  );
  return apiSuccess({ subscribed: false, removed }, id);
}
