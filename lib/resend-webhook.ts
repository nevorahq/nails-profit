import { and, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";

import { notificationOutbox, notificationProviderEvents } from "@/db/schema";
import { withTenant } from "@/db/tenant";

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
    if (inserted.length === 0) return "duplicate" as const;

    // Resend does not guarantee event ordering. Historical events stay in the
    // audit table, while the outbox summary only moves along provider time.
    await tx
      .update(notificationOutbox)
      .set({
        providerStatus,
        providerEventAt: eventCreatedAt,
        updatedAt: receivedAt,
      })
      .where(
        and(
          eq(notificationOutbox.id, notificationId),
          or(
            isNull(notificationOutbox.providerEventAt),
            lt(notificationOutbox.providerEventAt, eventCreatedAt),
          ),
        ),
      );

    return "recorded" as const;
  });
}
