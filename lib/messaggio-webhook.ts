import { and, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";

import { notificationOutbox, notificationProviderEvents } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { parseMessaggioExternalId } from "@/lib/notification-provider";

/**
 * Messaggio's own numeric delivery-report codes (API documentation, section
 * 3.1), mapped onto `notification_provider_status` rather than growing that
 * enum. Deliberately narrow: these are the only codes the documentation both
 * defines unambiguously and that apply to SMS specifically — 200 is the
 * platform accepting the request, 100 is the carrier handoff, 60 is SMS's own
 * terminal failure. Everything else (session/channel-availability codes that
 * read as Viber- or WhatsApp-specific, or request-shape errors already caught
 * by a non-2xx response to `POST /send`) is left unmapped rather than guessed
 * at; an unmapped status is ignored, not misfiled.
 */
const STATUS_MAP: Record<number, "accepted" | "sent" | "failed"> = {
  200: "accepted",
  100: "sent",
  60: "failed",
};

const deliveryReportSchema = z.object({
  type: z.string().min(1).max(40),
  message_id: z.string().min(1).max(200),
  external_id: z.string().min(1).max(200),
  status: z.number(),
});

export type MessaggioWebhookOutcome = "recorded" | "duplicate" | "ignored" | "unmatched";

/**
 * Parses only the fields needed for routing and delivery telemetry — nothing
 * about the message itself passes through Messaggio's callback, so there is
 * nothing here to discard the way `handleVerifiedResendWebhook` discards
 * recipient/subject/content.
 *
 * `receivedAt` doubles as the event time for the outbox summary; Messaggio's
 * own `timestamp` field is logged nowhere near PII but is not in the shape
 * `notification_provider_events.event_created_at` needs, so it is not
 * threaded through — `receivedAt` is what every event in that column already
 * means for this table.
 */
export async function handleVerifiedMessaggioWebhook(
  body: unknown,
  receivedAt = new Date(),
): Promise<MessaggioWebhookOutcome> {
  const parsed = deliveryReportSchema.safeParse(body);
  if (!parsed.success || parsed.data.type !== "status") return "ignored";

  const providerStatus = STATUS_MAP[parsed.data.status];
  if (!providerStatus) return "ignored";

  const reference = parseMessaggioExternalId(parsed.data.external_id);
  if (!reference || !z.uuid().safeParse(reference.notificationId).success) return "unmatched";
  const { organizationId, notificationId } = reference;

  return withTenant(organizationId, async (tx) => {
    const [notification] = await tx
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.id, notificationId),
          eq(notificationOutbox.providerMessageId, parsed.data.message_id),
        ),
      )
      .limit(1);
    if (!notification) return "unmatched" as const;

    // No provider-issued event id to deduplicate on, so one is built from what
    // is actually guaranteed unique: this message, at this status. A resend of
    // the same status (section 3 warns a non-200 response gets retried for
    // 24h) collides on purpose; a later, different status is a new row.
    const providerEventId = `${parsed.data.message_id}:${parsed.data.status}`;

    const inserted = await tx
      .insert(notificationProviderEvents)
      .values({
        organizationId,
        notificationId,
        providerEventId,
        providerMessageId: parsed.data.message_id,
        eventType: providerStatus,
        eventCreatedAt: receivedAt,
        receivedAt,
      })
      .onConflictDoNothing({ target: notificationProviderEvents.providerEventId })
      .returning({ id: notificationProviderEvents.id });
    if (inserted.length === 0) return "duplicate" as const;

    await tx
      .update(notificationOutbox)
      .set({ providerStatus, providerEventAt: receivedAt, updatedAt: receivedAt })
      .where(
        and(
          eq(notificationOutbox.id, notificationId),
          or(
            isNull(notificationOutbox.providerEventAt),
            lt(notificationOutbox.providerEventAt, receivedAt),
          ),
        ),
      );

    return "recorded" as const;
  });
}
