import { sql } from "drizzle-orm";

import { billingProviderEvents, organizationSubscriptions } from "@/db/schema";
import { withTenant } from "@/db/tenant";

export type NormalizedBillingEvent = Readonly<{
  provider: "paddle" | "lemon_squeezy";
  organizationId: string;
  providerCustomerId: string;
  providerSubscriptionId: string;
  providerPriceId: string;
  status: "trialing" | "active" | "past_due" | "paused" | "canceled";
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  manageUrl: string | null;
  /** The provider's own event name, kept on the event row — distinct from `status`. */
  rawEventType: string;
}>;

export type BillingWebhookOutcome = "applied" | "duplicate";

/**
 * The one place that knows about `organization_subscription` and
 * `billing_provider_event`. Paddle and Lemon Squeezy describe the same
 * underlying thing — a subscription's lifecycle — in different payload
 * shapes, so each provider file normalizes its own and hands it here rather
 * than duplicating the upsert.
 */
export async function applyBillingEvent(
  event: NormalizedBillingEvent,
  providerEventId: string,
): Promise<BillingWebhookOutcome> {
  return withTenant(event.organizationId, async (tx) => {
    // Paddle emits `subscription.created` and `subscription.trialing` within
    // milliseconds of each other when a checkout completes. Both reach here and
    // both try to INSERT the `organization_subscription` row; the loser
    // conflicts on `organization_subscription_org_idx`, which the upsert below
    // does not name as its arbiter, so PostgreSQL raises the violation instead
    // of updating and the webhook 500s (Paddle then retries). Serializing per
    // organization turns the race into two ordered upserts — the same idiom as
    // the "one organization per user" lock in `app/api/v1/organizations/route.ts`.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${event.organizationId}, 0))`);

    const inserted = await tx
      .insert(billingProviderEvents)
      .values({
        organizationId: event.organizationId,
        provider: event.provider,
        providerEventId,
        eventType: event.rawEventType,
      })
      .onConflictDoNothing({
        target: [billingProviderEvents.provider, billingProviderEvents.providerEventId],
      })
      .returning({ id: billingProviderEvents.id });
    if (inserted.length === 0) return "duplicate";

    await tx
      .insert(organizationSubscriptions)
      .values({
        organizationId: event.organizationId,
        provider: event.provider,
        providerCustomerId: event.providerCustomerId,
        providerSubscriptionId: event.providerSubscriptionId,
        providerPriceId: event.providerPriceId,
        status: event.status,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
        manageUrl: event.manageUrl,
      })
      .onConflictDoUpdate({
        target: [organizationSubscriptions.provider, organizationSubscriptions.providerSubscriptionId],
        set: {
          providerCustomerId: event.providerCustomerId,
          providerPriceId: event.providerPriceId,
          status: event.status,
          currentPeriodEnd: event.currentPeriodEnd,
          cancelAtPeriodEnd: event.cancelAtPeriodEnd,
          // Most `subscription.*` payloads omit `management_urls` (confirmed
          // against sandbox), so a later event must not wipe a link an earlier
          // one happened to carry.
          manageUrl: sql`coalesce(${event.manageUrl}, ${organizationSubscriptions.manageUrl})`,
          updatedAt: new Date(),
        },
      });

    return "applied";
  });
}
