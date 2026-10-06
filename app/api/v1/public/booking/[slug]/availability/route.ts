import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { parseLocalDate } from "@/domain/timezone";
import { apiError, apiSuccess, toFieldErrors, timedRoute } from "@/lib/http";
import {
  loadPublicAvailability,
  loadPublicAvailabilityRange,
  MAX_AVAILABILITY_DAYS,
} from "@/lib/public-booking-availability";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { publicNotFound, publicRequest, publicSessionKey } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_AVAILABILITY_RULE } from "@/lib/rate-limit";

const querySchema = z.object({
  location_id: z.uuid(),
  service_id: z.uuid(),
  add_on_ids: z.string().default(""),
  specialist_id: z.union([z.uuid(), z.literal("any")]).default("any"),
  date: z.string(),
  /**
   * Answer for this many days from `date` in one go — the ribbon of the public
   * page. Absent, only `date` is answered, as the manage page still asks.
   */
  days: z.coerce.number().int().min(1).max(MAX_AVAILABILITY_DAYS).optional(),
  /**
   * Every service of an appointment being moved, as `service:addOn:addOn|service`.
   *
   * Only the manage page sends it, for an appointment the studio booked with
   * more than one service: the slots it is offered must fit the whole sitting,
   * or the move it then asks for is refused. The public page books one service
   * and never sends it. Characters a UUID never contains, so no escaping.
   */
  services: z
    .string()
    .regex(/^[0-9a-f-]{36}(:[0-9a-f-]{36})*(\|[0-9a-f-]{36}(:[0-9a-f-]{36})*){0,9}$/i)
    .optional(),
});

function parseServices(value: string | undefined) {
  return value?.split("|").map((item) => {
    const [serviceId, ...addOnIds] = item.split(":");
    return { serviceId, addOnIds };
  });
}

async function handleGet(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { id, refused } = await publicRequest(
    request,
    PUBLIC_BOOKING_AVAILABILITY_RULE,
    "public_booking.availability",
  );
  if (refused) return refused;

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The query is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }
  const date = parseLocalDate(parsed.data.date);
  if (!date) {
    return apiError(422, "VALIDATION_ERROR", "The local date is invalid", id, {
      fieldErrors: [{ field: "date", code: "invalid_format", message: "Invalid local date" }],
    });
  }

  const { slug } = await params;
  const base = {
    slug,
    locationId: parsed.data.location_id,
    serviceId: parsed.data.service_id,
    addOnIds: parsed.data.add_on_ids ? parsed.data.add_on_ids.split(",").filter(Boolean) : [],
    specialistId: parsed.data.specialist_id === "any" ? null : parsed.data.specialist_id,
    date,
    items: parseServices(parsed.data.services),
    now: new Date(),
  };
  const result = parsed.data.days
    ? await loadPublicAvailabilityRange({ ...base, days: parsed.data.days })
    : await loadPublicAvailability(base);
  if (!result) return publicNotFound(id);

  const sessionKey = publicSessionKey(request);
  await withTenant(result.organizationId, async (tx) => {
    await recordPilotProductEvent(tx, {
      organizationId: result.organizationId,
      eventName: "booking_service_selected",
      actorUserId: null,
      actorRole: null,
      source: "api",
      entityType: "service",
      entityId: parsed.data.service_id,
      sessionKey,
    });
    await recordPilotProductEvent(tx, {
      organizationId: result.organizationId,
      eventName: "booking_availability_searched",
      actorUserId: null,
      actorRole: null,
      source: "api",
      entityType: "service",
      entityId: parsed.data.service_id,
      sessionKey,
    });
  });

  return apiSuccess(
    {
      timezone: result.timezone,
      currency: result.currency,
      ...("days" in result
        ? { days: result.days }
        : { slots: result.slots, nearest_dates: result.nearestDates }),
    },
    id,
  );
}

/** Section 7.10 measures this route; see `timedRoute`. */
export const GET = timedRoute("public.availability", handleGet);
