import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";

import { bookings } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { addLocalDays, formatLocalDate, toZonedParts } from "@/domain/timezone";
import { alternativeSlots, assertAssignable, loadBookingDraftFor, loadSlotContext } from "@/lib/availability-service";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { requireCalendarCaller } from "@/lib/booking-http";
import { ACTIVE_BOOKING_STATUSES, bookingLinesOf, loadBooking } from "@/lib/booking-service";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { bookingServicesOf } from "@/lib/visit-service";

/** The nearest days the search answers with, and how far past the target it looks. */
const DAYS_OFFERED = 3;
const HORIZON_DAYS = 14;
const SLOTS_PER_DAY = 8;

const weeksSchema = z.coerce.number().int().min(1).max(12);

/**
 * «Следующая запись»: the times the same sitting can be booked again, N weeks on.
 *
 * Asked from a closed appointment, because that is the moment a client is
 * still at the desk and the next visit is one question away. The same master,
 * the same address and the same services — read off the booking's own lines —
 * searched forward from the day N weeks after this one, with the busy time the
 * public page would respect: a suggestion that the desk then has to talk round
 * is not a suggestion.
 *
 * Only an answer. The booking itself is made by `POST /api/v1/bookings` with
 * `rebooked_from_booking_id`, so it is confirmed, written to the client and put in
 * the master's day exactly as any other booking taken by staff — a second way
 * to create an appointment would be a second set of those rules to keep.
 *
 * Writing, not reading: an Analyst may open the calendar but books nobody, and
 * offering them times they cannot take would be a form that ends in a 403.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "write");
  if (!caller.ok) return caller.response;

  const actor = caller.actor;
  const weeks = weeksSchema.safeParse(new URL(request.url).searchParams.get("weeks"));
  if (!weeks.success) {
    return apiError(422, "VALIDATION_ERROR", "weeks must be a whole number from 1 to 12", id, {
      fieldErrors: [{ field: "weeks", code: "invalid", message: "Expected 1–12" }],
    });
  }

  const { id: bookingId } = await context.params;
  const now = new Date();

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const booking = await loadBooking(tx, bookingId);
    if (!booking || !(await mayActOnSpecialist(tx, actor, booking.specialistId))) {
      return { failure: "not_found" as const };
    }
    if (booking.status !== "completed") return { failure: "not_completed" as const };
    // A next visit is somebody's next visit; with no card there is nobody to
    // write to and nothing for the return rate to count.
    if (!booking.clientId) return { failure: "no_client" as const };

    const slotContext = await loadSlotContext(tx, booking.locationId);
    if (!slotContext) return { failure: "location_not_found" as const };

    const booked = bookingServicesOf(await bookingLinesOf(tx, booking.id));
    if (!booked) return { failure: "not_bookable" as const };

    for (const item of booked.items) {
      const assignable = await assertAssignable(tx, {
        specialistId: booking.specialistId,
        locationId: booking.locationId,
        serviceId: item.serviceId,
      });
      if (assignable !== "ok") return { failure: assignable };
    }

    const draft = await loadBookingDraftFor(tx, {
      items: booked.items,
      specialistId: booking.specialistId,
    });
    if (!draft) return { failure: "not_bookable" as const };

    const visited = toZonedParts(booking.startsAt, slotContext.timezone);
    const target = addLocalDays({ year: visited.year, month: visited.month, day: visited.day }, weeks.data * 7);

    const days = await alternativeSlots(
      tx,
      {
        locationId: booking.locationId,
        specialistId: booking.specialistId,
        durationMinutes: draft.durationMinutes,
        date: target,
        now,
      },
      slotContext,
      { limit: DAYS_OFFERED, horizonDays: HORIZON_DAYS },
    );

    // Already coming back — with anyone. The desk should see that before it
    // books a second appointment the client did not ask for.
    const [upcoming] = await tx
      .select({ startsAt: bookings.startsAt })
      .from(bookings)
      .where(
        and(
          eq(bookings.clientId, booking.clientId),
          inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]),
          gt(bookings.startsAt, now),
        ),
      )
      .orderBy(asc(bookings.startsAt))
      .limit(1);

    return {
      booking,
      items: booked.items,
      timezone: slotContext.timezone,
      target: formatLocalDate(target),
      days,
      upcoming: upcoming?.startsAt ?? null,
    };
  });

  if ("failure" in outcome) {
    switch (outcome.failure) {
      case "not_found":
        return apiError(404, "BOOKING_NOT_FOUND", "No booking with this ID", id);
      case "not_completed":
        return apiError(409, "BOOKING_NOT_COMPLETED", "Only a closed appointment is booked again", id);
      case "no_client":
        return apiError(422, "BOOKING_HAS_NO_CLIENT", "The appointment has no client to book again", id);
      case "location_not_found":
        return apiError(404, "LOCATION_NOT_FOUND", "No bookable location with this ID", id);
      case "specialist_not_found":
        return apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", id);
      case "not_at_location":
        return apiError(422, "SPECIALIST_NOT_AT_LOCATION", "The specialist does not work here", id);
      case "service_not_offered":
        return apiError(422, "SERVICE_NOT_OFFERED", "The specialist does not perform this service", id);
      case "not_bookable":
        return apiError(422, "SERVICE_NOT_BOOKABLE", "The service has no bookable duration", id);
    }
  }

  return apiSuccess(
    {
      location_id: outcome.booking.locationId,
      specialist_id: outcome.booking.specialistId,
      client_id: outcome.booking.clientId,
      // What `POST /api/v1/bookings` takes, so the calendar sends it back as is.
      services: outcome.items.map((item) => ({ service_id: item.serviceId, add_on_ids: item.addOnIds })),
      timezone: outcome.timezone,
      target_date: outcome.target,
      days: outcome.days.map((day) => ({
        date: day.date,
        slots: day.slots.slice(0, SLOTS_PER_DAY).map((slot) => slot.start.toISOString()),
      })),
      upcoming_starts_at: outcome.upcoming,
    },
    id,
  );
}
