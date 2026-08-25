import type { NormalizedBillingEvent } from "@/lib/billing-subscription";
import { verifyHmacHex } from "@/lib/webhook-hmac";

/**
 * Lemon Squeezy signs the raw body directly — no timestamp component, unlike
 * Paddle's `ts:body`. That leaves no signature-level replay window, but the
 * `billing_provider_event` idempotency check in `applyBillingEvent` already
 * makes a replayed, validly-signed delivery a no-op, which is the protection
 * that actually matters here.
 */
export function verifyLemonSqueezyWebhook(rawBody: string, hexSignature: string, secret: string): boolean {
  return verifyHmacHex(rawBody, hexSignature, secret);
}

const STATUS_MAP: Record<string, NormalizedBillingEvent["status"]> = {
  on_trial: "trialing",
  active: "active",
  past_due: "past_due",
  paused: "paused",
  cancelled: "canceled",
  // Both are terminal failure-to-renew states distinct from a user-initiated
  // cancellation, but neither should leave the workspace unlocked.
  unpaid: "canceled",
  expired: "canceled",
};

type LemonSqueezyEventPayload = Readonly<{
  meta?: Readonly<{
    event_name?: unknown;
    custom_data?: Readonly<{ organization_id?: unknown }> | null;
  }>;
  data?: Readonly<{
    id?: unknown;
    attributes?: Readonly<{
      status?: unknown;
      customer_id?: unknown;
      variant_id?: unknown;
      renews_at?: unknown;
      cancelled?: unknown;
      urls?: Readonly<{ customer_portal?: unknown }> | null;
    }>;
  }>;
}>;

/** `null` for a non-subscription event or one missing a field the row requires. */
export function parseLemonSqueezyEvent(payload: unknown): NormalizedBillingEvent | null {
  const body = payload as LemonSqueezyEventPayload;
  const eventName = typeof body.meta?.event_name === "string" ? body.meta.event_name : "";
  if (!eventName.startsWith("subscription_")) return null;

  const organizationId = body.meta?.custom_data?.organization_id;
  const attributes = body.data?.attributes;
  const subscriptionId = body.data?.id;
  const status = typeof attributes?.status === "string" ? STATUS_MAP[attributes.status] : undefined;

  if (
    typeof organizationId !== "string" ||
    typeof subscriptionId !== "string" ||
    typeof attributes?.customer_id !== "number" ||
    typeof attributes?.variant_id !== "number" ||
    !status
  ) {
    return null;
  }

  const manageUrl = attributes.urls?.customer_portal;

  return {
    provider: "lemon_squeezy",
    organizationId,
    providerCustomerId: String(attributes.customer_id),
    providerSubscriptionId: subscriptionId,
    providerPriceId: String(attributes.variant_id),
    status,
    currentPeriodEnd: typeof attributes.renews_at === "string" ? new Date(attributes.renews_at) : null,
    cancelAtPeriodEnd: attributes.cancelled === true,
    manageUrl: typeof manageUrl === "string" ? manageUrl : null,
    rawEventType: eventName,
  };
}
