import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { formatLocalDate, parseLocalDate } from "@/domain/timezone";
import {
  assertAssignable,
  loadBookingDraftFor,
  loadSlotContext,
  slotsFor,
} from "@/lib/availability-service";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { requireCalendarCaller } from "@/lib/booking-http";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { MAX_SERVICES } from "@/domain/service-limit";

/**
 * How far ahead the desk may look. The public page keeps a client inside the
 * studio's advance window; a receptionist writing down an appointment for the
 * autumn is not a client, and `POST /api/v1/bookings` takes any date.
 */
const DESK_ADVANCE_DAYS = 3650;

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const querySchema = z.object({
  location_id: z.uuid(),
  specialist_id: z.uuid(),
  date: z.string(),
  /**
   * The sitting, as `service:addOn:addOn|service` — the shape the public
   * availability endpoint takes, and for the same reason: characters a UUID
   * never contains, so nothing needs escaping.
   */
  services: z.string().regex(new RegExp(`^${uuid}(:${uuid})*(\\|${uuid}(:${uuid})*)*$`, "i")),
});

/**
 * The times a master is free on one day, for the appointment form.
 *
 * The same engine the public page reads — the rota, less exceptions, less
 * everything standing in it with the studio's buffers — asked a different
 * question. The desk is not held to the public page's lead time or advance
 * window (staff create takes any time that does not collide), so both are
 * lifted here; a slot is offered only when it is genuinely empty, and one
 * already in the past is never offered.
 *
 * Writing, not reading: an Analyst opens the calendar but books nobody, and
 * times they cannot take would lead the form to a 403.
 */
export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "write");
  if (!caller.ok) return caller.response;
  const actor = caller.actor;

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The query is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const date = parseLocalDate(parsed.data.date);
  if (!date) {
    return apiError(422, "VALIDATION_ERROR", "date must be a calendar date, YYYY-MM-DD", id, {
      fieldErrors: [{ field: "date", code: "invalid", message: "Expected YYYY-MM-DD" }],
    });
  }

  const items = parsed.data.services.split("|").map((item) => {
    const [serviceId, ...addOnIds] = item.split(":");
    return { serviceId, addOnIds };
  });
  if (items.length > MAX_SERVICES || new Set(items.map((item) => item.serviceId)).size !== items.length) {
    return apiError(422, "VALIDATION_ERROR", "Too many services, or a service appears twice", id, {
      fieldErrors: [{ field: "services", code: "invalid", message: "Check the list of services" }],
    });
  }

  const now = new Date();

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    if (!(await mayActOnSpecialist(tx, actor, parsed.data.specialist_id))) {
      return { failure: "forbidden_specialist" as const };
    }

    const context = await loadSlotContext(tx, parsed.data.location_id);
    if (!context) return { failure: "location_not_found" as const };

    for (const item of items) {
      const assignable = await assertAssignable(tx, {
        specialistId: parsed.data.specialist_id,
        locationId: parsed.data.location_id,
        serviceId: item.serviceId,
      });
      if (assignable !== "ok") return { failure: assignable };
    }

    const draft = await loadBookingDraftFor(tx, { items, specialistId: parsed.data.specialist_id });
    if (!draft) return { failure: "not_bookable" as const };

    const slots = await slotsFor(
      tx,
      {
        locationId: parsed.data.location_id,
        specialistId: parsed.data.specialist_id,
        durationMinutes: draft.durationMinutes,
        date,
        now,
      },
      { ...context, settings: { ...context.settings, minLeadMinutes: 0, maxAdvanceDays: DESK_ADVANCE_DAYS } },
    );

    return { timezone: context.timezone, durationMinutes: draft.durationMinutes, slots };
  });

  if ("failure" in outcome) {
    switch (outcome.failure) {
      case "location_not_found":
        return apiError(404, "LOCATION_NOT_FOUND", "No bookable location with this ID", id);
      // Another master's calendar is answered like one that does not exist, as
      // `next-slots` answers an appointment that is not theirs.
      case "forbidden_specialist":
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
      date: formatLocalDate(date),
      timezone: outcome.timezone,
      duration_minutes: outcome.durationMinutes,
      slots: outcome.slots.map((slot) => slot.start.toISOString()),
    },
    id,
  );
}
