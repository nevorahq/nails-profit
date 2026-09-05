import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { notificationOutbox, notificationProviderEvents } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { advanceProviderStatus } from "@/lib/notification-provider-status";

const TRACKED_EVENTS = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
} as const;

const resendEventSchema = z.object({
  type: z.string().min(1).max(100),
  created_at: z.iso.datetime(),
  data: z.object({
    email_id: z.string().min(1).max(200),
    tags: z.record(z.string(), z.string()).optional().default({}),
  }),
});

export type ResendWebhookOutcome =
  | "recorded"
  | "duplicate"
  | "ignored"
  | "unmatched";

/**
 * Parses only fields needed for routing and delivery telemetry. Recipient,
 * sender, subject and content are intentionally discarded before persistence.
 */
export async function handleVerifiedResendWebhook(
  verifiedPayload: unknown,
  providerEventId: string,
  receivedAt = new Date(),
): Promise<ResendWebhookOutcome> {
  const parsed = resendEventSchema.safeParse(verifiedPayload);
  if (!parsed.success) return "ignored";

  const providerStatus = TRACKED_EVENTS[parsed.data.type as keyof typeof TRACKED_EVENTS];
  if (!providerStatus) return "ignored";

  const organizationId = parsed.data.data.tags.organization_id;
  const notificationId = parsed.data.data.tags.notification_id;
  if (!z.uuid().safeParse(organizationId).success || !z.uuid().safeParse(notificationId).success) {
    // Other Resend traffic (for example account password reset) has no outbox
    // tags and must be acknowledged without entering the booking event store.
    return "unmatched";
  }

  return withTenant(organizationId, async (tx) => {
    const [notification] = await tx
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.id, notificationId),
          eq(notificationOutbox.providerMessageId, parsed.data.data.email_id),
        ),
      )
      .limit(1);
    if (!notification) return "unmatched" as const;

    const eventCreatedAt = new Date(parsed.data.created_at);
    const inserted = await tx
      .insert(notificationProviderEvents)
      .values({
        organizationId,
        notificationId,
        providerEventId,
        providerMessageId: parsed.data.data.email_id,
        eventType: providerStatus,
        eventCreatedAt,
        receivedAt,
      })
      .onConflictDoNothing({ target: notificationProviderEvents.providerEventId })
      .returning({ id: notificationProviderEvents.id });

    /*
     * Resend does not guarantee event ordering. Historical events stay in the
     * audit table; the outbox summary only moves forward — `advanceProviderStatus`
     * holds what that means, including the case two events share a second and
     * time cannot decide between them.
     *
     * Attempted even for an event already seen. A redelivered webhook is
     * Resend's normal behaviour, and a summary that an earlier delivery failed
     * to move has no other chance to be corrected.
     */
    await advanceProviderStatus(tx, {
      notificationId,
      providerStatus,
      eventAt: eventCreatedAt,
      receivedAt,
    });

    return inserted.length === 0 ? ("duplicate" as const) : ("recorded" as const);
  });
}
