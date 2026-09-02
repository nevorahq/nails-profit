import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import {
  bookingVerifications,
  bookings,
  clients,
  locations,
  memberships,
  notificationOutbox,
  organizations,
  specialists,
  users,
} from "@/db/schema";
import { db } from "@/db";
import { withTenant, type TenantTransaction } from "@/db/tenant";
import { decideAfterFailure } from "@/domain/notification-schedule";
import { areNotificationsEnabled, getPublicAppUrl } from "@/env";
import { supportedLocales, type AppLocale } from "@/i18n/messages";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-service";
import { bookingPageUrl, issueManageLink } from "@/lib/booking-manage-link";
import { logEvent } from "@/lib/logger";
import {
  formatAppointmentTime,
  renderNotification,
  staffNotificationTemplates,
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

/**
 * Every tenant's queue in one call, for a scheduler that has no database of its
 * own.
 *
 * `scripts/notifications.mjs` answers "which organizations have something due"
 * with one cross-tenant statement over the operator connection, which is right
 * for an operator's laptop and wrong for a cron job in the deployment: it would
 * mean the production superuser credentials living in a scheduled function. The
 * organization list is readable by the application role — `organization` carries
 * no tenant column and its policy says so — and everything after that happens
 * inside `withTenant`, so nothing here steps outside the RLS boundary.
 *
 * Tenants are walked in turn rather than in parallel: the queue is small, and a
 * fan-out would open one connection per organization on a pool sized for
 * request traffic.
 */
export async function sweepDueNotifications(input?: {
  now?: Date;
  limit?: number;
}): Promise<DispatchSummary> {
  const now = input?.now ?? new Date();
  const total: { claimed: number; sent: number; retried: number; deadLettered: number } = {
    claimed: 0,
    sent: 0,
    retried: 0,
    deadLettered: 0,
  };
  if (!areNotificationsEnabled()) return total;

  const tenants = await db.select({ id: organizations.id }).from(organizations);

  for (const tenant of tenants) {
    await requeueStalled(tenant.id, now);
    const summary = await dispatchDueNotifications({
      organizationId: tenant.id,
      now,
      limit: input?.limit,
    });
    total.claimed += summary.claimed;
    total.sent += summary.sent;
    total.retried += summary.retried;
    total.deadLettered += summary.deadLettered;
  }

  return total;
}

/**
 * A message claimed by a process that then died stays `processing` and would
 * never be looked at again. Its attempt is already spent, so putting it back
 * cannot loop: after enough restarts it dead-letters like any other exhausted
 * message. Same rule and same window as the operator script.
 */
const STALE_PROCESSING_MINUTES = 15;

async function requeueStalled(organizationId: string, now: Date) {
  const requeued = await withTenant(organizationId, (tx) =>
    tx
      .update(notificationOutbox)
      .set({ status: "retry", updatedAt: now })
      .where(
        and(
          eq(notificationOutbox.status, "processing"),
          lte(notificationOutbox.updatedAt, new Date(now.getTime() - STALE_PROCESSING_MINUTES * 60_000)),
        ),
      )
      .returning({ id: notificationOutbox.id }),
  );

  if (requeued.length > 0) {
    logEvent("info", "notification.requeued_stalled", { organizationId }, { count: requeued.length });
  }
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
    result = await notificationProvider(prepared.message.channel).send(prepared.message);
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
    : staffNotificationTemplates.includes(template)
      ? await staffFacts(tx, organizationId, row)
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
    specialist: facts.specialist ?? "",
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
      /** Set where a message names the master; absent where none belongs. */
      specialist?: string;
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

/**
 * Who in the studio hears about a waiting request, and where they answer it.
 *
 * The master the appointment was booked with, through the account linked to
 * their card. When no account is linked — an invited master whose card was
 * never created, which is the state this whole message exists to survive — it
 * goes to an owner instead: somebody has to be able to confirm, and an owner
 * always can.
 *
 * Resolved at delivery rather than written into the queue, so a link made in
 * the minutes after the booking still routes the message to the right person.
 * The address is not a client's, so no manage link is minted: the destination
 * is the appointment inside the application, which is where confirming happens.
 */
async function staffFacts(
  tx: TenantTransaction,
  organizationId: string,
  row: ClaimedRow,
): Promise<Facts> {
  if (!row.bookingId) return { ok: false, code: "booking_missing" };

  const [found] = await tx
    .select({
      startsAt: bookings.startsAt,
      status: bookings.status,
      timezone: locations.timezone,
      specialistEmail: users.email,
    })
    .from(bookings)
    .innerJoin(locations, eq(locations.id, bookings.locationId))
    .innerJoin(specialists, eq(specialists.id, bookings.specialistId))
    .leftJoin(users, eq(users.id, specialists.userId))
    .where(eq(bookings.id, row.bookingId))
    .limit(1);
  if (!found) return { ok: false, code: "booking_missing" };

  // Answered while the message waited — by the owner in the calendar, or by the
  // request expiring. Sending now would ask for a decision already made.
  if (found.status !== "pending_confirmation") return { ok: false, code: "booking_not_pending" };

  /*
   * Which of the studio's people this row is for. Rows written before the
   * owner's copy existed carry no recipient, and are read the way they were
   * meant: the master if their card has an account, the owner otherwise.
   */
  const recipient = row.payload?.recipient ?? (found.specialistEmail ? "specialist" : "owner");

  let destination = recipient === "specialist" ? found.specialistEmail : null;
  if (recipient === "owner") {
    const [owner] = await tx
      .select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.role, "owner")))
      .orderBy(asc(memberships.createdAt))
      .limit(1);
    destination = owner?.email ?? null;
  }
  if (!destination) return { ok: false, code: "no_destination" };

  return {
    ok: true,
    destination,
    // Null so the studio's own language is used: here the reader is the studio.
    locale: null,
    appointment: { startsAt: found.startsAt, timezone: found.timezone },
    link: `${getPublicAppUrl()}/app/calendar/${row.bookingId}`,
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
      specialistName: specialists.name,
    })
    .from(bookings)
    .innerJoin(locations, eq(locations.id, bookings.locationId))
    // The card's name, read at delivery like every other fact here: a master
    // renamed between the answer and the send is named as they are now.
    .innerJoin(specialists, eq(specialists.id, bookings.specialistId))
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

  // Two templates that are not about managing this appointment any more — it is
  // cancelled, or it already happened — so they point at the studio's booking
  // page instead of minting a manage link for a booking nobody can change.
  const link =
    template === "booking.cancelled" || template === "booking.visit_completed"
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
    specialist: found.specialistName,
    link,
  };
}

function asLocale(value: string | null): AppLocale | null {
  return supportedLocales.includes(value as AppLocale) ? (value as AppLocale) : null;
}
