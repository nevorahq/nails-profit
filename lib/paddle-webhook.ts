import type { NormalizedBillingEvent } from "@/lib/billing-subscription";
import { verifyHmacHex } from "@/lib/webhook-hmac";

export type PaddleSignatureHeader = Readonly<{ ts: string; h1: string }>;

/** `Paddle-Signature: ts=1671552777;h1=<hex>` → its two named parts, or `null` if either is missing. */
export function parsePaddleSignatureHeader(header: string): PaddleSignatureHeader | null {
  const parts: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [key, value] = part.split("=");
    if (key && value) parts[key.trim()] = value.trim();
  }
  return parts.ts && parts.h1 ? { ts: parts.ts, h1: parts.h1 } : null;
}

/**
 * Paddle signs `${ts}:${rawBody}`, not the body alone (Billing API webhook
 * docs). `maxAgeSeconds` rejects a replayed, otherwise-valid signature — kept
 * generous rather than Paddle's own tighter suggestion, since this is written
 * before any account/sandbox exists to measure real delivery latency against;
 * revisit once one does.
 */
export function verifyPaddleWebhook(
  rawBody: string,
  header: PaddleSignatureHeader,
  secret: string,
  now = new Date(),
  maxAgeSeconds = 300,
): boolean {
  const ts = Number(header.ts);
  if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > maxAgeSeconds) return false;
  return verifyHmacHex(`${header.ts}:${rawBody}`, header.h1, secret);
}

const STATUS_MAP: Record<string, NormalizedBillingEvent["status"]> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  paused: "paused",
  canceled: "canceled",
};

type PaddleEventPayload = Readonly<{
  event_id?: unknown;
  event_type?: unknown;
  data?: Readonly<{
    id?: unknown;
    customer_id?: unknown;
    status?: unknown;
    current_billing_period?: Readonly<{ ends_at?: unknown }> | null;
    scheduled_change?: Readonly<{ action?: unknown }> | null;
    items?: readonly Readonly<{ price?: Readonly<{ id?: unknown }> }>[];
    custom_data?: Readonly<{ organization_id?: unknown }> | null;
    // Field name per the Billing API's subscription resource; unconfirmed
    // against a live payload since no Paddle account exists yet — re-check
    // once one does.
    management_urls?: Readonly<{ update_payment_method?: unknown; cancel?: unknown }> | null;
  }>;
}>;

/**
 * `null` for anything not a subscription lifecycle event (Paddle also sends
 * `transaction.*` and other event families) or missing a field the row
 * requires — both come back to the route as "ignore, still answer 200".
 */
export function parsePaddleEvent(payload: unknown): NormalizedBillingEvent | null {
  const body = payload as PaddleEventPayload;
  const eventType = typeof body.event_type === "string" ? body.event_type : "";
  if (!eventType.startsWith("subscription.")) return null;

  const data = body.data;
  const organizationId = data?.custom_data?.organization_id;
  const subscriptionId = data?.id;
  const customerId = data?.customer_id;
  const priceId = data?.items?.[0]?.price?.id;
  const status = typeof data?.status === "string" ? STATUS_MAP[data.status] : undefined;

  if (
    typeof organizationId !== "string" ||
    typeof subscriptionId !== "string" ||
    typeof customerId !== "string" ||
    typeof priceId !== "string" ||
    !status
  ) {
    return null;
  }

  const endsAt = data?.current_billing_period?.ends_at;
  const manageUrl = data?.management_urls?.update_payment_method ?? data?.management_urls?.cancel;

  return {
    provider: "paddle",
    organizationId,
    providerCustomerId: customerId,
    providerSubscriptionId: subscriptionId,
    providerPriceId: priceId,
    status,
    currentPeriodEnd: typeof endsAt === "string" ? new Date(endsAt) : null,
    cancelAtPeriodEnd: data?.scheduled_change?.action === "cancel",
    manageUrl: typeof manageUrl === "string" ? manageUrl : null,
    rawEventType: eventType,
  };
}
