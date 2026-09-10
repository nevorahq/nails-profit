import { withTenant, type TenantTransaction } from "@/db/tenant";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnSpecialist } from "@/lib/booking-access";
import {
  cancelPendingNotifications,
  notifyBooking,
  scheduleBookingReminder,
} from "@/lib/booking-notifications";
import type { CalendarCaller } from "@/lib/booking-http";
import {
  bookingLinesOf,
  loadBooking,
  transitionBooking,
  type BookingRow,
  type BookingStatus,
  type MutationFailure,
} from "@/lib/booking-service";
import { logEvent } from "@/lib/logger";
import { recordPilotProductEvent, type PilotEventName } from "@/lib/pilot-events";
import type { bookingLines } from "@/db/schema";

/**
 * Confirming, cancelling and marking a no-show are the same operation with a
 * different destination.
 *
 * Each is one status change, one audit event and one product event, and each is
 * refused for the same reasons. Three copies of that would be three chances for
 * one of them to forget the "own calendar" check, which is the only part of it
 * an attacker cares about.
 */
export type StaffTransition = Readonly<{
  to: BookingStatus;
  auditEventType: string;
  productEvent: PilotEventName;
  /** Set on a cancellation; the schema refuses one without an initiator. */
  cancelledBy?: "client" | "staff" | "system";
  reason?: string | null;
  expectedVersion?: number | null;
}>;

export type TransitionOutcome =
  | Readonly<{
      ok: true;
      booking: BookingRow;
      lines: readonly (typeof bookingLines.$inferSelect)[];
      /**
       * How the client was told, for the transitions that tell them.
       *
       * Null where the transition says nothing to a client at all — closing a
       * visit, marking a no-show. An empty array is the case worth surfacing:
       * there was a message to send and no way to send it, because the person
       * has neither an address nor a number on their card. SMS now covers the
       * client who has only a phone, so what is left here is the client who has
       * neither, and for them the only channel is somebody picking one up.
       */
      notifiedChannels: readonly ("email" | "sms")[] | null;
    }>
  | MutationFailure;

/**
 * What the client is told when the studio changes a booking, section 7.7.
 *
 * Sitting in the transition rather than in each route is what keeps a fourth
 * staff action from quietly shipping without it.
 *
 * Arriving at `confirmed` here always means one thing. `BOOKING_TRANSITIONS`
 * reaches `confirmed` from `pending_confirmation` and nowhere else, so a
 * confirmation that passes through a staff action is by construction the answer
 * to a request — and the client is told who answered it. The plainer
 * "запись подтверждена" belongs to the bookings that were never requests: taken
 * at the desk, or confirmed on arrival by the studio's instant setting, both of
 * which enqueue their own message where they are created.
 *
 * A no-show and a completion end the appointment without anything left to say
 * to the client — but both make a pending reminder wrong, so it goes.
 */
async function notifyTransition(
  tx: TenantTransaction,
  organizationId: string,
  booking: BookingRow,
  now: Date,
): Promise<readonly ("email" | "sms")[] | null> {
  if (booking.status === "confirmed") {
    const channels = await notifyBooking(tx, {
      organizationId,
      bookingId: booking.id,
      template: "booking.request_accepted",
      occurrence: String(booking.version),
    });
    await scheduleBookingReminder(tx, {
      organizationId,
      bookingId: booking.id,
      locationId: booking.locationId,
      startsAt: booking.startsAt,
      now,
    });
    return channels;
  }

  if (booking.status === "cancelled") {
    const channels = await notifyBooking(tx, {
      organizationId,
      bookingId: booking.id,
      template: "booking.cancelled",
      occurrence: String(booking.version),
    });
    await cancelPendingNotifications(tx, booking.id);
    return channels;
  }

  await cancelPendingNotifications(tx, booking.id);
  // Null rather than an empty list, and the difference is what the desk needs
  // to know: a completion has no message to fail to send, while a cancellation
  // with no channels is a client who has not been told their visit is off.
  return null;
}

export async function applyStaffTransition(
  actor: CalendarCaller,
  bookingId: string,
  transition: StaffTransition,
  requestIdentifier: string,
): Promise<TransitionOutcome> {
  const now = new Date();

  const outcome = await withTenant(actor.organizationId, async (tx): Promise<TransitionOutcome> => {
    const existing = await loadBooking(tx, bookingId);
    if (!existing) return { ok: false, failure: "not_found" };
    // A Master acts on their own calendar. Answering 404 rather than 403 keeps
    // an id belonging to a colleague from being confirmed as a real booking.
    if (!(await mayActOnSpecialist(tx, actor, existing.specialistId))) {
      return { ok: false, failure: "not_found" };
    }

    const moved = await transitionBooking(tx, {
      bookingId,
      to: transition.to,
      expectedVersion: transition.expectedVersion ?? null,
      actor: transition.cancelledBy,
      reason: transition.reason ?? null,
      actorUserId: actor.userId,
      now,
    });
    if (!moved.ok) return moved;

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: transition.auditEventType,
      entityType: "booking",
      entityId: moved.booking.id,
      before: { status: existing.status },
      after: { status: moved.booking.status, reason: transition.reason ?? null },
      requestId: requestIdentifier,
    });

    await recordPilotProductEvent(tx, {
      organizationId: actor.organizationId,
      eventName: transition.productEvent,
      actorUserId: actor.userId,
      actorRole: actor.role,
      source: "api",
      entityType: "booking",
      entityId: moved.booking.id,
    });

    const notifiedChannels = await notifyTransition(tx, actor.organizationId, moved.booking, now);

    return {
      ok: true,
      booking: moved.booking,
      lines: await bookingLinesOf(tx, moved.booking.id),
      notifiedChannels,
    };
  });

  if (outcome.ok) {
    logEvent(
      "info",
      `booking.${transition.to}`,
      { requestId: requestIdentifier, organizationId: actor.organizationId, userId: actor.userId },
      { booking_id: outcome.booking.id, status: outcome.booking.status },
    );
  }

  return outcome;
}
