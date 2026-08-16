import { and, asc, eq, inArray } from "drizzle-orm";

import {
  bookingSettings,
  bookings,
  clients,
  memberships,
  notificationOutbox,
  organizations,
  specialists,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { reminderTimeFor } from "@/domain/notification-schedule";
import { getNotificationProviderName } from "@/env";
import type { BookingNotificationTemplate } from "@/lib/notification-message";

export type { BookingNotificationTemplate };

type Channel = "email" | "sms";

/**
 * Writing to the outbox, roadmap section 7.7: "Notification outbox
 * записывается в той же транзакции, что и booking event".
 *
 * In the transaction, so a message cannot exist for an appointment that rolled
 * back and an appointment cannot commit without the message it promised. What
 * happens afterwards — the provider, the retries, the dead letters — belongs to
 * `notification-dispatch` and must never be awaited here: a provider that is
 * slow would otherwise hold a booking transaction open, and a provider that is
 * down would fail the booking.
 */
export async function enqueueBookingNotification(
  tx: TenantTransaction,
  input: {
    organizationId: string;
    bookingId: string;
    channel: Channel;
    template: BookingNotificationTemplate;
    occurrence?: string;
    scheduledAt?: Date;
  },
) {
  await insertOutbox(tx, {
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    verificationId: null,
    channel: input.channel,
    template: input.template,
    occurrence: input.occurrence,
    scheduledAt: input.scheduledAt,
    payload: null,
  });
}

/**
 * Telling the studio that a request is waiting for an answer.
 *
 * Until this existed, a public request notified the client and nobody else: the
 * appointment sat in `pending_confirmation` until somebody happened to open the
 * calendar. On the pilot that is exactly what happened — the master never
 * learned there was anything to confirm, and read the silence as the booking
 * having failed.
 *
 * Two people hear about it: the master the appointment was booked with, and the
 * owner, who asked to see every request whether or not it is theirs to work.
 * One row each, so one can fail or dead-letter without taking the other with
 * it; which person a row is for is written into its payload, and their address
 * is looked up at delivery by `staffFacts` in `notification-dispatch`.
 *
 * Email only, and deliberately: the studio side of the product has an account
 * with an address, never a phone number, so there is no second channel to
 * choose between.
 */
export async function notifyStaffOfRequest(
  tx: TenantTransaction,
  input: { organizationId: string; bookingId: string },
) {
  const [target] = await tx
    .select({ specialistUserId: specialists.userId })
    .from(bookings)
    .innerJoin(specialists, eq(specialists.id, bookings.specialistId))
    .where(eq(bookings.id, input.bookingId))
    .limit(1);

  const [owner] = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.organizationId, input.organizationId), eq(memberships.role, "owner")))
    .orderBy(asc(memberships.createdAt))
    .limit(1);

  const specialistUserId = target?.specialistUserId ?? null;

  /*
   * One row per person, decided here rather than at delivery: a single row with
   * a fallback would send the owner's copy only when the master had no account,
   * which is the opposite of "владелец видит все запросы". Rows are only
   * written for people who exist — a card with no account produces no master's
   * message at all, so nothing dead-letters on its way to nobody.
   */
  if (specialistUserId) {
    await insertOutbox(tx, {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      verificationId: null,
      channel: "email",
      template: "booking.staff_requested",
      payload: { recipient: "specialist" },
    });
  }

  // The owner already heard about it if the master is them: one address, one
  // message, however many roles the person happens to hold.
  if (owner && owner.userId !== specialistUserId) {
    await insertOutbox(tx, {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      verificationId: null,
      channel: "email",
      template: "booking.staff_requested",
      occurrence: "owner",
      payload: { recipient: "owner" },
    });
  }
}

/**
 * Thanking the client once the visit is closed.
 *
 * The transition code says a completion leaves "nothing left to say to the
 * client", and that was true while every template was about managing an
 * appointment: the visit is over, there is nothing to confirm, move or cancel.
 * This one is not about the appointment — it is the studio's own follow-up, and
 * the way back is the booking page.
 *
 * Sent only where there is a way back: an organization with no public booking
 * page would be inviting the client to a link that does not exist. Whether the
 * client can be reached at all is decided by `notifyBooking`, from their record
 * rather than from an assumption here.
 */
export async function notifyVisitCompleted(
  tx: TenantTransaction,
  input: { organizationId: string; bookingId: string },
) {
  const [organization] = await tx
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  if (!organization?.slug) return;

  await notifyBooking(tx, {
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    template: "booking.visit_completed",
  });
}

/** The one message that carries a secret; see `notification_outbox.payload`. */
export async function enqueueVerificationNotification(
  tx: TenantTransaction,
  input: {
    organizationId: string;
    verificationId: string;
    channel: Channel;
    code: string;
    occurrence: string;
  },
) {
  await insertOutbox(tx, {
    organizationId: input.organizationId,
    bookingId: null,
    verificationId: input.verificationId,
    channel: input.channel,
    template: "booking.verification_code",
    occurrence: input.occurrence,
    scheduledAt: undefined,
    payload: { code: input.code },
  });
}

async function insertOutbox(
  tx: TenantTransaction,
  input: {
    organizationId: string;
    bookingId: string | null;
    verificationId: string | null;
    channel: Channel;
    template: BookingNotificationTemplate;
    occurrence?: string;
    scheduledAt?: Date;
    payload: { code?: string; recipient?: "specialist" | "owner" } | null;
  },
) {
  /**
   * The logical send, not the attempt: section 7.7 asks for an idempotency key
   * on the former. Two code paths reacting to one event — a route and a repair
   * job both noticing the same cancellation — produce the same key and one
   * message, which is what `onConflictDoNothing` below relies on.
   */
  const idempotencyKey = [
    input.bookingId ?? input.verificationId,
    input.template,
    input.channel,
    input.occurrence ?? "initial",
  ].join(":");

  const at = input.scheduledAt ?? new Date();
  await tx
    .insert(notificationOutbox)
    .values({
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      verificationId: input.verificationId,
      channel: input.channel,
      template: input.template,
      idempotencyKey,
      payload: input.payload,
      scheduledAt: at,
      nextAttemptAt: at,
    })
    .onConflictDoNothing();
}

/**
 * One event, every channel the client can be reached on.
 *
 * Resolved from the client record rather than passed in, because the two public
 * routes that used to do this by hand disagreed about it: one looked up the
 * email, the other assumed there was none. A booking with no client — a staff
 * placeholder in the calendar — notifies nobody, and that is not an error.
 */
export async function notifyBooking(
  tx: TenantTransaction,
  input: {
    organizationId: string;
    bookingId: string;
    template: BookingNotificationTemplate;
    occurrence?: string;
    scheduledAt?: Date;
  },
) {
  const [booking] = await tx
    .select({ clientId: bookings.clientId })
    .from(bookings)
    .where(eq(bookings.id, input.bookingId))
    .limit(1);
  if (!booking?.clientId) return [] as Channel[];

  const [client] = await tx
    .select({ phone: clients.normalizedPhone, email: clients.email })
    .from(clients)
    .where(eq(clients.id, booking.clientId))
    .limit(1);
  if (!client) return [] as Channel[];

  const channels: Channel[] =
    getNotificationProviderName() === "resend"
      ? client.email
        ? ["email"]
        : []
      : [
          ...(client.phone ? (["sms"] as const) : []),
          ...(client.email ? (["email"] as const) : []),
        ];

  for (const channel of channels) {
    await enqueueBookingNotification(tx, {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      channel,
      template: input.template,
      occurrence: input.occurrence,
      scheduledAt: input.scheduledAt,
    });
  }

  return channels;
}

/**
 * The reminder of section 7.7, queued the moment an appointment becomes real.
 *
 * A future `scheduled_at` is the whole scheduler: the dispatcher already sends
 * only what is due, so a reminder is an ordinary row that becomes due later.
 * Adding a second timer to walk bookings looking for reminders would be a
 * second source of truth about when to send one.
 *
 * The start time is part of the idempotency key, so an appointment moved twice
 * accumulates neither two reminders for the old time nor a silent none.
 */
export async function scheduleBookingReminder(
  tx: TenantTransaction,
  input: {
    organizationId: string;
    bookingId: string;
    locationId: string;
    startsAt: Date;
    now: Date;
  },
) {
  const [settings] = await tx
    .select({ leadMinutes: bookingSettings.reminderLeadMinutes })
    .from(bookingSettings)
    .where(eq(bookingSettings.locationId, input.locationId))
    .limit(1);
  if (!settings) return null;

  const at = reminderTimeFor(input.startsAt, settings.leadMinutes, input.now);
  if (!at) return null;

  await notifyBooking(tx, {
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    template: "booking.reminder",
    occurrence: input.startsAt.toISOString(),
    scheduledAt: at,
  });

  return at;
}

/**
 * Drops messages that have not gone out yet.
 *
 * Deleted rather than marked, because an unsent row is a message that never
 * happened — keeping it as history would put "reminder" in the delivery
 * statistics of an appointment nobody was reminded about. Anything already
 * sent stays exactly where it is.
 */
export async function cancelPendingNotifications(
  tx: TenantTransaction,
  bookingId: string,
  templates: readonly BookingNotificationTemplate[] = ["booking.reminder"],
) {
  const dropped = await tx
    .delete(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.bookingId, bookingId),
        inArray(notificationOutbox.status, ["pending", "retry"]),
        inArray(notificationOutbox.template, [...templates]),
      ),
    )
    .returning({ id: notificationOutbox.id });

  return dropped.length;
}
