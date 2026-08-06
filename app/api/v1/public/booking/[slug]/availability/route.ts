import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { parseLocalDate } from "@/domain/timezone";
import { apiError, apiSuccess, toFieldErrors, timedRoute } from "@/lib/http";
import { loadPublicAvailability } from "@/lib/public-booking-availability";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_AVAILABILITY_RULE } from "@/lib/rate-limit";

const querySchema = z.object({
  location_id: z.uuid(),
  service_id: z.uuid(),
  add_on_ids: z.string().default(""),
  specialist_id: z.union([z.uuid(), z.literal("any")]).default("any"),
  date: z.string(),
});

async function handleGet(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { id, refused } = publicRequest(
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
  const result = await loadPublicAvailability({
    slug,
    locationId: parsed.data.location_id,
    serviceId: parsed.data.service_id,
    addOnIds: parsed.data.add_on_ids ? parsed.data.add_on_ids.split(",").filter(Boolean) : [],
    specialistId: parsed.data.specialist_id === "any" ? null : parsed.data.specialist_id,
    date,
    now: new Date(),
  });
  if (!result) return publicNotFound(id);

  await withTenant(result.organizationId, async (tx) => {
    await recordPilotProductEvent(tx, {
      organizationId: result.organizationId,
      eventName: "booking_service_selected",
      actorUserId: null,
      actorRole: null,
      source: "api",
      entityType: "service",
      entityId: parsed.data.service_id,
    });
    await recordPilotProductEvent(tx, {
      organizationId: result.organizationId,
      eventName: "booking_availability_searched",
      actorUserId: null,
      actorRole: null,
      source: "api",
      entityType: "service",
      entityId: parsed.data.service_id,
    });
  });

  return apiSuccess(
    { timezone: result.timezone, currency: result.currency, slots: result.slots },
    id,
  );
}

/** Section 7.10 measures this route; see `timedRoute`. */
export const GET = timedRoute("public.availability", handleGet);
