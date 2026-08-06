import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import {
  bookingVerifications,
  bookings,
  clients,
  locations,
  notificationOutbox,
  organizations,
} from "@/db/schema";
import { withTenant, type TenantTransaction } from "@/db/tenant";
import { decideAfterFailure } from "@/domain/notification-schedule";
import { areNotificationsEnabled } from "@/env";
import { supportedLocales, type AppLocale } from "@/i18n/messages";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-service";
import { bookingPageUrl, issueManageLink } from "@/lib/booking-manage-link";
import { logEvent } from "@/lib/logger";
import {
  formatAppointmentTime,
  renderNotification,
  type BookingNotificationTemplate,
} from "@/lib/notification-message";
import { notificationProvider, type OutgoingMessage } from "@/lib/notification-provider";

/**
 * The scheduler half of the outbox, roadmap section 7.7.
 *
 * The booking transaction writes a row; this sends it. Nothing here runs inside
 * a booking's transaction on purpose: "ошибка provider не отменяет уже
 * сохранённую запись" is only true if the appointment is committed before
 * anyone talks to a provider, and it is the reason an outbox exists at all
 * instead of an HTTP call in the middle of a booking.
 *
 * Three transactions per message, not one:
 *
 *   1. claim — `for update skip locked`, so two dispatchers on two instances
 *      divide the queue instead of fighting over its head;
 *   2. prepare — reads the booking and mints the manage link, then commits, so
 *      no transaction stays open across a provider call;
 *   3. finalize — records what the provider said.
 *
 * The attempt is counted at claim time rather than at finalize time. A process
 * killed mid-send has already spent its attempt, which is what stops a message
 * whose provider call hangs from being retried forever by successive restarts.
 */

/** One batch's worth. Small enough that a crash re-does little, big enough to drain. */
const DEFAULT_BATCH = 25;

export type DispatchSummary = Readonly<{
  claimed: number;
  sent: number;
  retried: number;
  deadLettered: number;
}>;

type ClaimedRow = typeof notificationOutbox.$inferSelect;

type Prepared =
  | Readonly<{ ok: true; message: OutgoingMessage }>
  | Readonly<{ ok: false; code: string }>;

export async function dispatchDueNotifications(input: {
  organizationId: string;
  now?: Date;
  limit?: number;
}): Promise<DispatchSummary> {
  const now = input.now ?? new Date();
  const empty: DispatchSummary = { claimed: 0, sent: 0, retried: 0, deadLettered: 0 };

  // Section 7's rollback: paused delivery leaves the queue intact, so turning
  // sending back on sends what accumulated rather than losing it.
  if (!areNotificationsEnabled()) return empty;

  const claimed = await claimDue(input.organizationId, now, input.limit ?? DEFAULT_BATCH);
  if (claimed.length === 0) return empty;

  let sent = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const row of claimed) {
    const outcome = await deliver(input.organizationId, row, now);
    if (outcome === "sent") sent += 1;
    else if (outcome === "retry") retried += 1;
    else deadLettered += 1;
  }

  const summary = { claimed: claimed.length, sent, retried, deadLettered };
  logEvent("info", "notification.dispatched", { organizationId: input.organizationId }, summary);
  return summary;
}

async function claimDue(organizationId: string, now: Date, limit: number): Promise<ClaimedRow[]> {
  return withTenant(organizationId, async (tx) => {
    const due = await tx
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(
        and(
          inArray(notificationOutbox.status, ["pending", "retry"]),
          lte(notificationOutbox.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(notificationOutbox.nextAttemptAt), asc(notificationOutbox.id))
      .limit(limit)
      .for("update", { skipLocked: true });

    if (due.length === 0) return [];

    return tx
      .update(notificationOutbox)
      .set({
        status: "processing",
        attempts: sql`${notificationOutbox.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        inArray(
          notificationOutbox.id,
          due.map((row) => row.id),
        ),
      )
      .returning();
  });
}

async function deliver(
  organizationId: string,
  row: ClaimedRow,
  now: Date,
): Promise<"sent" | "retry" | "dead_letter"> {
  const prepared = await withTenant(organizationId, (tx) => prepare(tx, organizationId, row, now));
  if (!prepared.ok) {
    // Nothing about this row will improve by trying again: no client, no phone
    // number, a reminder for an appointment that was cancelled.
    await finalize(organizationId, row.id, now, { status: "dead_letter", code: prepared.code });
    return "dead_letter";
  }

  let result;
  try {
    result = await notificationProvider().send(prepared.message);
  } catch (error) {
    // A provider adapter that throws is a provider that did not answer, which
    // is the definition of an error worth retrying.
    result = {
      ok: false as const,
      code: error instanceof Error ? "provider_exception" : "provider_error",
      retryable: true,
    };
  }

  if (result.ok) {
    await finalize(organizationId, row.id, now, {
      status: "sent",
      providerMessageId: result.providerMessageId,
    });
    return "sent";
  }

  const decision = decideAfterFailure(row.attempts, result.retryable, now);
  if (decision.status === "retry") {
    await finalize(organizationId, row.id, now, {
      status: "retry",
      code: result.code,
      nextAttemptAt: decision.nextAttemptAt,
    });
    return "retry";
  }

  logEvent(
    "warn",
    "notification.dead_letter",
    { organizationId },
    { template: row.template, channel: row.channel, attempts: row.attempts, code: result.code },
  );
  await finalize(organizationId, row.id, now, { status: "dead_letter", code: result.code });
  return "dead_letter";
}

async function finalize(
  organizationId: string,
  id: string,
  now: Date,
  outcome:
    | Readonly<{ status: "sent"; providerMessageId: string }>
    | Readonly<{ status: "retry"; code: string; nextAttemptAt: Date }>
    | Readonly<{ status: "dead_letter"; code: string }>,
) {
  await withTenant(organizationId, async (tx) => {
    await tx
      .update(notificationOutbox)
      .set({
        status: outcome.status,
        updatedAt: now,
        ...(outcome.status === "sent"
          ? {
              sentAt: now,
              providerMessageId: outcome.providerMessageId,
              providerStatus: "accepted",
              lastErrorCode: null,
              // The one-time code has left the building; it must not outlive
              // the send it was written for.
              payload: null,
            }
          : {}),
        ...(outcome.status === "retry"
          ? { nextAttemptAt: outcome.nextAttemptAt, lastErrorCode: outcome.code }
          : {}),
        ...(outcome.status === "dead_letter" ? { lastErrorCode: outcome.code, payload: null } : {}),
      })
      .where(eq(notificationOutbox.id, id));
  });
}

async function prepare(
  tx: TenantTransaction,
  organizationId: string,
  row: ClaimedRow,
  now: Date,
): Promise<Prepared> {
  const template = row.template as BookingNotificationTemplate;

  const [organization] = await tx
    .select({ name: organizations.name, slug: organizations.slug, locale: organizations.locale })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) return { ok: false, code: "organization_missing" };

  const facts = row.verificationId
    ? await verificationFacts(tx, row.verificationId, now)
    : await bookingFacts(tx, row, template, organization.slug, now);
  if (!facts.ok) return facts;

  // The client's own language when they chose one, the studio's otherwise:
  // LOC-008 puts the organization's language first only where the reader is
  // the studio, and here the reader is the client.
  const locale = asLocale(facts.locale) ?? asLocale(organization.locale) ?? "ru";
  const rendered = renderNotification({
    template,
    locale,
    studioName: organization.name,
    when: facts.appointment
      ? formatAppointmentTime(facts.appointment.startsAt, facts.appointment.timezone, locale)
      : "",
    link: facts.link,
    code: row.payload?.code ?? "",
  });

  return {
    ok: true,
    message: {
      channel: row.channel,
      destination: facts.destination,
      subject: rendered.subject,
      body: rendered.body,
      idempotencyKey: row.idempotencyKey,
      tags: [
        { name: "organization_id", value: organizationId },
        { name: "notification_id", value: row.id },
      ],
    },
  };
}

type Facts =
  | Readonly<{
      ok: true;
      destination: string;
      locale: string | null;
      /** Absent for a verification code, which is about a slot, not a booking. */
      appointment: Readonly<{ startsAt: Date; timezone: string }> | null;
      link: string;
    }>
  | Readonly<{ ok: false; code: string }>;

async function verificationFacts(
  tx: TenantTransaction,
  verificationId: string,
  now: Date,
): Promise<Facts> {
  const [verification] = await tx
    .select()
    .from(bookingVerifications)
    .where(eq(bookingVerifications.id, verificationId))
    .limit(1);
  if (!verification) return { ok: false, code: "verification_missing" };
  // A code that would arrive after it stops working is worse than no code: the
  // client types it, is refused, and blames the studio.
  if (verification.expiresAt <= now) return { ok: false, code: "verification_expired" };

  return {
    ok: true,
    destination: verification.destination,
    locale: verification.locale,
    appointment: null,
    link: "",
  };
}

async function bookingFacts(
  tx: TenantTransaction,
  row: ClaimedRow,
  template: BookingNotificationTemplate,
  slug: string | null,
  now: Date,
): Promise<Facts> {
  if (!row.bookingId) return { ok: false, code: "booking_missing" };

  const [found] = await tx
    .select({
      booking: bookings,
      timezone: locations.timezone,
      clientLocale: clients.locale,
      clientPhone: clients.normalizedPhone,
      clientEmail: clients.email,
    })
    .from(bookings)
    .innerJoin(locations, eq(locations.id, bookings.locationId))
    .leftJoin(clients, eq(clients.id, bookings.clientId))
    .where(eq(bookings.id, row.bookingId))
    .limit(1);
  if (!found) return { ok: false, code: "booking_missing" };

  // A reminder is the one message whose reason can disappear between writing
  // and sending. Cancelling drops pending reminders, so this is the net under
  // that: a reminder for an appointment nobody is coming to is never sent.
  if (
    template === "booking.reminder" &&
    !ACTIVE_BOOKING_STATUSES.includes(found.booking.status as (typeof ACTIVE_BOOKING_STATUSES)[number])
  ) {
    return { ok: false, code: "booking_inactive" };
  }

  const destination = row.channel === "sms" ? found.clientPhone : found.clientEmail;
  if (!destination) return { ok: false, code: "no_destination" };

  const link =
    template === "booking.cancelled"
      ? slug
        ? bookingPageUrl(slug)
        : ""
      : (
          await issueManageLink(tx, {
            organizationId: found.booking.organizationId,
            bookingId: found.booking.id,
            now,
          })
        ).url;

  return {
    ok: true,
    destination,
    locale: found.clientLocale,
    appointment: { startsAt: found.booking.startsAt, timezone: found.timezone },
    link,
  };
}

function asLocale(value: string | null): AppLocale | null {
  return supportedLocales.includes(value as AppLocale) ? (value as AppLocale) : null;
}
