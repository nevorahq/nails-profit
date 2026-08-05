import { withTenant } from "@/db/tenant";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnSpecialist } from "@/lib/booking-access";
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
    }>
  | MutationFailure;

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

    return { ok: true, booking: moved.booking, lines: await bookingLinesOf(tx, moved.booking.id) };
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
