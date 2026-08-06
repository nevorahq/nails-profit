import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { workplaces } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { toZonedParts } from "@/domain/timezone";
import { loadBookingDraft, loadSlotContext } from "@/lib/availability-service";
import { holdSlot, HOLD_TTL_MINUTES } from "@/lib/booking-service";
import { isExclusionViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, toFieldErrors } from "@/lib/http";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { recordSuspiciousActivity } from "@/lib/bot-challenge";
import { loadPublicCatalog } from "@/lib/public-booking";
import { loadPublicAvailability } from "@/lib/public-booking-availability";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_HOLD_RULE } from "@/lib/rate-limit";

const bodySchema = z.object({
  location_id: z.uuid(),
  service_id: z.uuid(),
  add_on_ids: z.array(z.uuid()).max(20).default([]),
  specialist_id: z.uuid(),
  starts_at: z.iso.datetime(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { id, caller, refused } = publicRequest(request, PUBLIC_BOOKING_HOLD_RULE, "public_booking.hold", {
    challenge: true,
  });
  if (refused) return refused;

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { slug } = await params;
  const catalogue = await loadPublicCatalog(slug, parsed.data.location_id);
  if (!catalogue) return publicNotFound(id);

  const startsAt = new Date(parsed.data.starts_at);
  const local = toZonedParts(startsAt, catalogue.location.timezone);
  const availability = await loadPublicAvailability({
    slug,
    locationId: parsed.data.location_id,
    serviceId: parsed.data.service_id,
    addOnIds: parsed.data.add_on_ids,
    specialistId: parsed.data.specialist_id,
    date: { year: local.year, month: local.month, day: local.day },
    now: new Date(),
  });
  const offered = availability?.slots.find(
    (slot) =>
      slot.starts_at === startsAt.toISOString() &&
      slot.specialist_id === parsed.data.specialist_id,
  );
  if (!availability || !offered) {
    // Asking to hold a time that was never offered is what a script does and
    // what a form cannot.
    recordSuspiciousActivity(caller);
    return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id, {
      details: { alternatives: availability?.slots.slice(0, 6) ?? [] },
    });
  }

  try {
    const result = await withTenant(catalogue.organization.id, async (tx) => {
      const context = await loadSlotContext(tx, parsed.data.location_id);
      if (!context || context.publicStatus !== "published") return null;

      const draft = await loadBookingDraft(tx, {
        serviceId: parsed.data.service_id,
        addOnIds: parsed.data.add_on_ids,
        specialistId: parsed.data.specialist_id,
      });
      if (!draft) return null;

      const workplace = draft.requiresWorkplace
        ? (
            await tx
              .select({ id: workplaces.id })
              .from(workplaces)
              .where(
                and(
                  eq(workplaces.locationId, parsed.data.location_id),
                  eq(workplaces.status, "active"),
                ),
              )
              .orderBy(asc(workplaces.sortOrder), asc(workplaces.id))
              .limit(1)
          )[0]
        : null;
      if (draft.requiresWorkplace && !workplace) return null;

      const held = await holdSlot(tx, {
        organizationId: catalogue.organization.id,
        locationId: parsed.data.location_id,
        specialistId: parsed.data.specialist_id,
        workplaceId: workplace?.id ?? null,
        interval: { start: startsAt, end: new Date(offered.ends_at) },
        // A verified page asks for a code between holding the slot and
        // confirming it, and five minutes to receive an SMS and type six digits
        // is a hold that expires on the client rather than a slot protected
        // from other clients.
        ...(context.verificationMode === "code"
          ? { ttlMinutes: HOLD_TTL_MINUTES + context.verificationTtlMinutes }
          : {}),
        now: new Date(),
      });
      if (!held.ok) return held;

      await recordPilotProductEvent(tx, {
        organizationId: catalogue.organization.id,
        eventName: "booking_slot_held",
        actorUserId: null,
        actorRole: null,
        source: "api",
        entityType: "booking_hold",
        entityId: held.holdId,
      });

      return held;
    });

    if (!result) return apiError(422, "SERVICE_NOT_BOOKABLE", "The service cannot be booked", id);
    if (!result.ok) {
      return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id, {
        details: { conflict: result.conflict, alternatives: availability.slots.slice(0, 6) },
      });
    }

    return apiSuccess(
      {
        hold_token: result.token.token,
        expires_at: result.expiresAt.toISOString(),
        slot: offered,
      },
      id,
      201,
    );
  } catch (error) {
    if (isExclusionViolation(error)) {
      return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id, {
        details: { alternatives: availability.slots.slice(0, 6) },
      });
    }
    throw error;
  }
}
