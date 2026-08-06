import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { toZonedParts } from "@/domain/timezone";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { bookingPayload, mutationFailureResponse, requireCalendarCaller } from "@/lib/booking-http";
import {
  cancelPendingNotifications,
  notifyBooking,
  scheduleBookingReminder,
} from "@/lib/booking-notifications";
import { bookingLinesOf, loadBooking, rescheduleBooking } from "@/lib/booking-service";
import { alternativeSlots, assertAssignable, describeAlternatives, loadSlotContext } from "@/lib/availability-service";
import { isExclusionViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors, timedRoute } from "@/lib/http";
import { logEvent } from "@/lib/logger";
import { recordPilotProductEvent } from "@/lib/pilot-events";

/**
 * Moving an appointment, roadmap section 7.6.
 *
 * The booked duration travels with it: what was agreed was ninety minutes of
 * this specialist's time, and a move is a change of when, not of what. Changing
 * the service is cancelling and booking again, which is also what the client
 * would be told on the phone.
 *
 * `version` is required here, unlike on confirm or cancel. Those are protected
 * by the transition table — a second confirm is refused because the booking is
 * no longer pending — but a second move has nothing to catch it: it would
 * silently overwrite a time somebody else had just agreed with the client.
 */
const rescheduleSchema = z.object({
  starts_at: z.iso.datetime(),
  /** Handing the appointment to a colleague is a reschedule too. */
  specialist_id: z.uuid().optional(),
  workplace_id: z.uuid().nullable().optional(),
  version: z.int().positive(),
});

async function handlePost(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "write");
  if (!caller.ok) return caller.response;

  const actor = caller.actor;
  const body = await request.json().catch(() => null);
  const parsed = rescheduleSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id: bookingId } = await context.params;
  const startsAt = new Date(parsed.data.starts_at);
  const now = new Date();

  try {
    const outcome = await withTenant(actor.organizationId, async (tx) => {
      const existing = await loadBooking(tx, bookingId);
      if (!existing) return { ok: false as const, failure: "not_found" as const };
      if (!(await mayActOnSpecialist(tx, actor, existing.specialistId))) {
        return { ok: false as const, failure: "not_found" as const };
      }

      const specialistId = parsed.data.specialist_id ?? existing.specialistId;
      // Moving to a colleague is only a move if that colleague can do the work
      // at that address. The check is the same one creation makes, because the
      // resulting appointment is the same kind of thing.
      if (specialistId !== existing.specialistId) {
        if (!(await mayActOnSpecialist(tx, actor, specialistId))) {
          return { ok: false as const, failure: "forbidden_specialist" as const };
        }

        const serviceLine = (await bookingLinesOf(tx, existing.id)).find((line) => line.kind === "service");
        if (serviceLine?.serviceId) {
          const assignable = await assertAssignable(tx, {
            specialistId,
            locationId: existing.locationId,
            serviceId: serviceLine.serviceId,
          });
          if (assignable !== "ok") return { ok: false as const, failure: assignable };
        }
      }

      const duration = existing.endsAt.getTime() - existing.startsAt.getTime();
      const interval = { start: startsAt, end: new Date(startsAt.getTime() + duration) };

      const moved = await rescheduleBooking(tx, {
        organizationId: actor.organizationId,
        bookingId: existing.id,
        interval,
        specialistId,
        workplaceId: parsed.data.workplace_id,
        expectedVersion: parsed.data.version,
        actorUserId: actor.userId,
        now,
      });

      if (!moved.ok) {
        if (moved.failure !== "conflict") return moved;

        // Section 7.8: the nearest free times travel with the refusal, so the
        // person on the phone has something to offer instead of "no".
        const context = await loadSlotContext(tx, existing.locationId);
        const alternatives = context
          ? await alternativeSlots(
              tx,
              {
                locationId: existing.locationId,
                specialistId,
                durationMinutes: Math.round(duration / 60_000),
                date: (({ year, month, day }) => ({ year, month, day }))(
                  toZonedParts(startsAt, context.timezone),
                ),
                // Offering the appointment's current hour back is the whole
                // point when the move it is being offered instead of failed.
                excludeBookingId: existing.id,
                now,
              },
              context,
            )
          : [];

        return { ok: false as const, failure: "conflict" as const, conflict: moved.conflict, alternatives };
      }

      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "booking.rescheduled",
        entityType: "booking",
        entityId: moved.booking.id,
        before: {
          starts_at: moved.previous.start,
          ends_at: moved.previous.end,
          specialist_id: existing.specialistId,
        },
        after: {
          starts_at: moved.booking.startsAt,
          ends_at: moved.booking.endsAt,
          specialist_id: moved.booking.specialistId,
        },
        requestId: id,
      });

      await recordPilotProductEvent(tx, {
        organizationId: actor.organizationId,
        eventName: "booking_rescheduled",
        actorUserId: actor.userId,
        actorRole: actor.role,
        source: "api",
        entityType: "booking",
        entityId: moved.booking.id,
      });

      // Section 7.7's "дата, время, мастер или услуга изменены": the client
      // agreed to a time, and the studio changing it is precisely the case
      // where they must not find out on arrival.
      await notifyBooking(tx, {
        organizationId: actor.organizationId,
        bookingId: moved.booking.id,
        template: "booking.rescheduled",
        occurrence: String(moved.booking.version),
      });
      await cancelPendingNotifications(tx, moved.booking.id);
      await scheduleBookingReminder(tx, {
        organizationId: actor.organizationId,
        bookingId: moved.booking.id,
        locationId: moved.booking.locationId,
        startsAt: moved.booking.startsAt,
        now,
      });

      return { ok: true as const, booking: moved.booking, lines: await bookingLinesOf(tx, moved.booking.id) };
    });

    if (!outcome.ok) {
      switch (outcome.failure) {
        case "forbidden_specialist":
          return apiError(403, "FORBIDDEN", "This role may only move its own appointments", id);
        case "specialist_not_found":
          return apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", id);
        case "not_at_location":
          return apiError(422, "SPECIALIST_NOT_AT_LOCATION", "The specialist does not work here", id);
        case "service_not_offered":
          return apiError(422, "SERVICE_NOT_OFFERED", "The specialist does not perform this service", id);
        case "conflict":
          logEvent(
            "info",
            "booking.slot_conflict",
            { requestId: id, organizationId: actor.organizationId, userId: actor.userId },
            { conflict: outcome.conflict, operation: "reschedule" },
          );
          return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id, {
            details: {
              conflict: outcome.conflict,
              alternatives: describeAlternatives(outcome.alternatives),
            },
          });
        default:
          return mutationFailureResponse(outcome, id);
      }
    }

    return apiSuccess(bookingPayload(outcome.booking, outcome.lines), id);
  } catch (error) {
    // Two moves onto one slot at the same instant: the constraint decides, and
    // the loser sees what it would have seen from the check.
    if (isExclusionViolation(error)) {
      logEvent(
        "warn",
        "booking.exclusion_violation",
        { requestId: id, organizationId: actor.organizationId, userId: actor.userId },
        { operation: "reschedule" },
      );
      return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id, {
        details: { conflict: "booking", alternatives: [] },
      });
    }
    throw error;
  }
}

/** Section 7.10 measures this route; see `timedRoute`. */
export const POST = timedRoute("staff.booking.reschedule", handlePost);
