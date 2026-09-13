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
import {
  smsNotificationTemplates,
  smsReplacesEmail,
  type BookingNotificationTemplate,
  type StaffNotificationTemplate,
} from "@/lib/notification-message";
import { recordStaffNotice, type StaffNoticeKind } from "@/lib/staff-notices";

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
 * Telling the studio what a client did on the public page.
 *
 * Until this existed, a public request notified the client and nobody else: the
 * appointment sat in `pending_confirmation` until somebody happened to open the
 * calendar. On the pilot that is exactly what happened — the master never
 * learned there was anything to confirm, and read the silence as the booking
 * having failed.
 *
 * The same silence covered three more events, and this now carries all four.
 * A booking taken under instant confirmation needs no answer but still fills
 * somebody's hour; a client who moves a visit moves that hour; a client who
 * calls one off frees it for somebody else. None of them asks the studio for a
 * decision, which is precisely why none of them was reaching anyone — and why
 * the person whose chair it is found out by opening the calendar, or didn't.
 *
 * Two people hear about it: the master the appointment was booked with, and the
 * owner, who asked to see everything whether or not it is theirs to work. One
 * row each, so one can fail or dead-letter without taking the other with it;
 * which person a row is for is written into its payload, and their address is
 * looked up at delivery by `staffFacts` in `notification-dispatch`.
 *
 * `occurrence` is what keeps a second move from being swallowed as a duplicate
 * of the first: the idempotency key is built from it, so a caller reacting to a
 * change passes the booking's new version. The owner's copy carries the same
 * value with `:owner` on the end — without it the two rows would share a key
 * and only one person would be written to.
 *
 * Email only, and deliberately: the studio side of the product has an account
 * with an address, never a phone number, so there is no second channel to
 * choose between.
 */
/**
 * Which of the studio's messages is also worth a line in the app.
 *
 * `booking.staff_requested` is deliberately absent: an unanswered request is
 * already the bell's first group, and a request that appeared in both would be
 * closed in one and left standing in the other.
 */
const STAFF_NOTICE_KIND: Partial<Record<StaffNotificationTemplate, StaffNoticeKind>> = {
  "booking.staff_booked": "client_booked",
  "booking.staff_rescheduled": "client_rescheduled",
  "booking.staff_cancelled": "client_cancelled",
};

export async function notifyStaff(
  tx: TenantTransaction,
  input: {
    organizationId: string;
    bookingId: string;
    template: StaffNotificationTemplate;
    occurrence?: string;
  },
) {
  const [target] = await tx
    .select({ specialistId: bookings.specialistId, specialistUserId: specialists.userId })
    .from(bookings)
    .innerJoin(specialists, eq(specialists.id, bookings.specialistId))
    .where(eq(bookings.id, input.bookingId))
    .limit(1);

  /*
   * The same event as a line in the app, written here because this is already
   * the function every client-caused change calls to tell the studio. A request
   * is the exception: it has its own place in the bell — the list of things
   * waiting for an answer — and saying it twice would make one of them noise.
   *
   * The client has no account, so the notice has no actor, which is what makes
   * it visible to everyone rather than to everyone but the person who did it.
   */
  const noticeKind = STAFF_NOTICE_KIND[input.template];
  if (noticeKind && target) {
    await recordStaffNotice(tx, {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      kind: noticeKind,
      specialistId: target.specialistId,
      actorUserId: null,
    });
  }

  const [owner] = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.organizationId, input.organizationId), eq(memberships.role, "owner")))
    .orderBy(asc(memberships.createdAt))
    .limit(1);

  /*
   * The front desk, when the studio has asked for it.
   *
   * A manager holds `bookings` at «Да» and their whole job is answering a
   * request — and they were told about one only by opening the app. Not made a
   * rule, because one message is written per recipient and a studio with two
   * administrators would get four emails for one request; `staff_notices` is
   * where that is decided by whoever knows the shift (`db/schema.ts`).
   */
  const [organization] = await tx
    .select({ audience: organizations.staffNotices })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);

  const managers =
    organization?.audience === "owner_and_managers"
      ? await tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(
            and(
              eq(memberships.organizationId, input.organizationId),
              eq(memberships.role, "manager"),
            ),
          )
          .orderBy(asc(memberships.createdAt))
      : [];

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
      template: input.template,
      occurrence: input.occurrence,
      payload: { recipient: "specialist" },
    });
  }

  /*
   * One address, one message, however many roles the person happens to hold.
   * The owner is skipped when they are the master; a manager is skipped when
   * they are the master, and again when they are somehow the owner too.
   */
  for (const manager of managers) {
    if (manager.userId === specialistUserId || manager.userId === owner?.userId) continue;
    await insertOutbox(tx, {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      verificationId: null,
      channel: "email",
      template: input.template,
      occurrence: input.occurrence
        ? `${input.occurrence}:manager:${manager.userId}`
        : `manager:${manager.userId}`,
      payload: { recipient: "member", userId: manager.userId },
    });
  }

  if (owner && owner.userId !== specialistUserId) {
    await insertOutbox(tx, {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      verificationId: null,
      channel: "email",
      template: input.template,
      occurrence: input.occurrence ? `${input.occurrence}:owner` : "owner",
      payload: { recipient: "owner" },
    });
  }
}

/**
 * Telling the master a client just moved off.
 *
 * The one message in the product addressed to somebody the appointment no
 * longer belongs to, and the reason it needs a function of its own: `notifyStaff`
 * fans out to whoever holds the booking now, which after a move to another
 * master is precisely the wrong person. This one has a single reader, and their
 * hour is the thing the message is about.
 *
 * Written only where there is somebody to write to. A card with no linked
 * account has no inbox, and the owner is not offered a copy: they already get
 * `booking.staff_rescheduled` for the same move, and a second message about one
 * event is how a studio learns to stop reading them.
 *
 * The master and the hour travel in the payload rather than being looked up at
 * delivery, against the rule every other message here follows. They have to:
 * the booking has moved on, and by the time the queue comes round it names the
 * new master and the new time.
 */
export async function notifyReleasedSpecialist(
  tx: TenantTransaction,
  input: {
    organizationId: string;
    bookingId: string;
    specialistId: string;
    startsAt: Date;
    occurrence: string;
  },
) {
  /*
   * The line goes in whether or not there is an inbox to write to. A card with
   * no linked account gets no message — there is nowhere to send one — but the
   * hour is still free in somebody's day, and whoever opens the studio's app
   * should see that it is. Which is the difference between the two: a message
   * needs an address, a notice needs only a reader.
   */
  await recordStaffNotice(tx, {
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    kind: "client_released",
    specialistId: input.specialistId,
    actorUserId: null,
    previousStartsAt: input.startsAt,
  });

  const [previous] = await tx
    .select({ userId: specialists.userId })
    .from(specialists)
    .where(eq(specialists.id, input.specialistId))
    .limit(1);
  if (!previous?.userId) return;

  await insertOutbox(tx, {
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    verificationId: null,
    channel: "email",
    template: "booking.staff_released",
    occurrence: input.occurrence,
    payload: {
      recipient: "previous_specialist",
      specialistId: input.specialistId,
      startsAt: input.startsAt.toISOString(),
    },
  });
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
    payload: {
      code?: string;
      recipient?: "specialist" | "owner" | "previous_specialist" | "member";
      specialistId?: string;
      /** Which account a `member` row is for — see `staffNoticeAudience`. */
      userId?: string;
      startsAt?: string;
    } | null;
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
 *
 * Email goes wherever the client left an address; SMS goes only for the templates in
 * `smsNotificationTemplates`, which is the reminder and nothing else. It used to go for
 * all of them, which is how one public request put two paid messages on a client's
 * phone six seconds apart: that the request had arrived, and then that it was accepted.
 * The first says nothing the second does not, and it costs the same to send.
 *
 * The consequence, stated rather than discovered: a client the studio entered with a
 * phone and no email is reminded of their appointment and hears nothing else at all —
 * not that it was booked, not that it was called off. Whether that client should exist
 * is the studio's call, made when they type the card; what the code owes them is to
 * fail visibly rather than quietly, so a caller that needed a message delivered reads
 * the channels this returns. `manage-link` is the one that does, and answers 422.
 *
 * Each channel resolves its own provider: `notificationProvider`
 * (see `lib/notification-provider.ts`) gives it its own adapter, or `log` when that
 * channel has none configured — either way delivery is attempted rather than the row
 * sitting in `dead_letter` forever.
 */
export async function notifyBooking(
  tx: TenantTransaction,
  input: {
    organizationId: string;
    bookingId: string;
    template: BookingNotificationTemplate;
    occurrence?: string;
    scheduledAt?: Date;
    /**
     * Who caused the event, where the row cannot say.
     *
     * A cancellation records its actor in `cancelled_by`, so this is read from
     * the booking when it is not passed. A move records nothing — there is no
     * `rescheduled_by` column — and the difference matters: a client moving
     * their own appointment on the public page is watching the screen that
     * does it, and does not need to be texted about it.
     */
    causedBy?: "client" | "staff" | "system";
  },
) {
  const [booking] = await tx
    .select({
      clientId: bookings.clientId,
      // Read for `smsReplacesEmail`: a client who cancelled the appointment
      // themselves is not told about their own decision.
      cancelledBy: bookings.cancelledBy,
    })
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

  /*
   * Two rules, not one, and the second is the whole point.
   *
   * `smsNotificationTemplates` is "SMS as well as the email" — the reminder,
   * which every client gets on their phone because that is the message whose
   * absence costs an empty chair.
   *
   * `smsReplacesEmail` is "SMS because there is no email", and it exists for a
   * client the studio typed in at the desk: `client.email` is nullable and for
   * them it is usually null, so until now the studio cancelling their
   * appointment reached them through no channel at all. They arrived to a
   * locked door, and the studio looked like the one who had failed.
   *
   * A client with an address is unaffected — same email, same cost. The phone
   * is used only where the alternative is silence.
   */
  const channels: Channel[] = [];
  if (client.phone && smsNotificationTemplates.includes(input.template)) channels.push("sms");
  if (client.email) channels.push("email");
  else if (
    client.phone &&
    !channels.includes("sms") &&
    smsReplacesEmail(input.template, input.causedBy ?? booking.cancelledBy)
  ) {
    channels.push("sms");
  }

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
