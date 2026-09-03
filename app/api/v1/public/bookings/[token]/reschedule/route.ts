import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { bookingIdempotencyKeys, workplaces } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { toZonedParts } from "@/domain/timezone";
import { loadBookingDraft } from "@/lib/availability-service";
import { recordAuditEvent } from "@/lib/audit";
import {
  cancelPendingNotifications,
  notifyBooking,
  scheduleBookingReminder,
} from "@/lib/booking-notifications";
import { loadBooking, rescheduleBooking } from "@/lib/booking-service";
import { isExclusionViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, toFieldErrors, timedRoute } from "@/lib/http";
import { claimIdempotencyKey, fingerprintOf, recordIdempotentResult } from "@/lib/idempotency";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { loadPublicBookingAccess } from "@/lib/public-booking-access";
import { loadPublicAvailability } from "@/lib/public-booking-availability";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_MANAGE_RULE } from "@/lib/rate-limit";

const schema = z.object({
  starts_at: z.iso.datetime(),
  specialist_id: z.uuid(),
  version: z.int().positive(),
});

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { id, refused } = await publicRequest(request, PUBLIC_BOOKING_MANAGE_RULE, "public_booking.reschedule");
  if (refused) return refused;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return apiError(422, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header is required", id);
  }
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { token } = await params;
  const access = await loadPublicBookingAccess(token);
  if (!access || !access.dto.service_id) return publicNotFound(id);

  const fingerprint = fingerprintOf(parsed.data);
  const scope = `booking.public_reschedule:${access.booking.id}`;
  // A retry arrives after the destination is occupied by this very booking, so
  // it must be recognized before availability is recalculated.
  const previous = await withTenant(access.organizationId, async (tx) => {
    const [row] = await tx
      .select({
        requestFingerprint: bookingIdempotencyKeys.requestFingerprint,
        bookingId: bookingIdempotencyKeys.bookingId,
      })
      .from(bookingIdempotencyKeys)
      .where(
        and(
          eq(bookingIdempotencyKeys.scope, scope),
          eq(bookingIdempotencyKeys.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (previous) {
    if (previous.requestFingerprint !== fingerprint || previous.bookingId !== access.booking.id) {
      return apiError(409, "IDEMPOTENCY_KEY_REUSED", "This key belongs to another request", id);
    }
    return apiSuccess(
      {
        starts_at: access.booking.startsAt,
        ends_at: access.booking.endsAt,
        specialist_id: access.booking.specialistId,
        version: access.booking.version,
        replayed: true,
      },
      id,
    );
  }

  const startsAt = new Date(parsed.data.starts_at);
  const local = toZonedParts(startsAt, access.dto.location.timezone);
  const availability = await loadPublicAvailability({
    slug: access.dto.organization_slug,
    locationId: access.dto.location.id,
    serviceId: access.dto.service_id,
    addOnIds: access.dto.add_on_ids,
    specialistId: parsed.data.specialist_id,
    date: { year: local.year, month: local.month, day: local.day },
    // Moving by fifteen minutes is a move, and the booking's own hour is only
    // taken because of the booking being moved out of it.
    excludeBookingId: access.booking.id,
    now: new Date(),
  });
  const offered = availability?.slots.find(
    (slot) =>
      slot.starts_at === startsAt.toISOString() &&
      slot.specialist_id === parsed.data.specialist_id,
  );
  if (!offered) {
    return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id, {
      details: { alternatives: availability?.slots.slice(0, 6) ?? [] },
    });
  }

  const now = new Date();
  try {
    const outcome = await withTenant(access.organizationId, async (tx) => {
      const claim = await claimIdempotencyKey(tx, {
        organizationId: access.organizationId,
        scope,
        key: idempotencyKey,
        fingerprint,
      });
      if (claim.status === "conflict") {
        return { ok: false as const, failure: "idempotency_conflict" as const };
      }
      if (claim.status === "replay") {
        if (claim.bookingId !== access.booking.id) {
          return { ok: false as const, failure: "idempotency_conflict" as const };
        }
        const existing = await loadBooking(tx, access.booking.id);
        return existing
          ? { ok: true as const, booking: existing, replay: true as const }
          : { ok: false as const, failure: "not_bookable" as const };
      }

      const draft = await loadBookingDraft(tx, {
        serviceId: access.dto.service_id!,
        addOnIds: access.dto.add_on_ids,
        specialistId: parsed.data.specialist_id,
      });
      if (!draft) return { ok: false as const, failure: "not_bookable" as const };

      const workplace = draft.requiresWorkplace
        ? (
            await tx
              .select({ id: workplaces.id })
              .from(workplaces)
              .where(
                and(
                  eq(workplaces.locationId, access.dto.location.id),
                  eq(workplaces.status, "active"),
                ),
              )
              .orderBy(asc(workplaces.sortOrder), asc(workplaces.id))
              .limit(1)
          )[0]
        : null;
      if (draft.requiresWorkplace && !workplace) {
        return { ok: false as const, failure: "not_bookable" as const };
      }

      const moved = await rescheduleBooking(tx, {
        organizationId: access.organizationId,
        bookingId: access.booking.id,
        interval: { start: startsAt, end: new Date(offered.ends_at) },
        specialistId: parsed.data.specialist_id,
        workplaceId: workplace?.id ?? null,
        expectedVersion: parsed.data.version,
        actorUserId: null,
        now,
      });
      if (!moved.ok) return moved;
      await recordIdempotentResult(tx, claim.id, moved.booking.id);

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        actorUserId: null,
        eventType: "booking.rescheduled",
        entityType: "booking",
        entityId: access.booking.id,
        before: {
          starts_at: moved.previous.start,
          ends_at: moved.previous.end,
          specialist_id: access.booking.specialistId,
        },
        after: {
          starts_at: moved.booking.startsAt,
          ends_at: moved.booking.endsAt,
          specialist_id: moved.booking.specialistId,
        },
        requestId: id,
      });
      await recordPilotProductEvent(tx, {
        organizationId: access.organizationId,
        eventName: "booking_rescheduled",
        actorUserId: null,
        actorRole: null,
        source: "api",
        entityType: "booking",
        entityId: access.booking.id,
      });
      await notifyBooking(tx, {
        organizationId: access.organizationId,
        bookingId: access.booking.id,
        template: "booking.rescheduled",
        occurrence: String(moved.booking.version),
      });
      // The reminder belonged to the old time; it is dropped and re-queued for
      // the new one, so a client is never reminded of an appointment that moved.
      await cancelPendingNotifications(tx, access.booking.id);
      await scheduleBookingReminder(tx, {
        organizationId: access.organizationId,
        bookingId: access.booking.id,
        locationId: access.dto.location.id,
        startsAt: moved.booking.startsAt,
        now,
      });
      return { ...moved, replay: false as const };
    });

    if (!outcome.ok) {
      if (outcome.failure === "idempotency_conflict") {
        return apiError(409, "IDEMPOTENCY_KEY_REUSED", "This key belongs to another request", id);
      }
      if (outcome.failure === "version_conflict") {
        return apiError(409, "VERSION_CONFLICT", "This booking changed", id, {
          details: { current_version: outcome.current },
        });
      }
      if (outcome.failure === "conflict") {
        return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id);
      }
      return apiError(409, "CANNOT_RESCHEDULE", "This booking cannot be moved", id);
    }
    return apiSuccess(
      {
        starts_at: outcome.booking.startsAt,
        ends_at: outcome.booking.endsAt,
        specialist_id: outcome.booking.specialistId,
        version: outcome.booking.version,
        replayed: outcome.replay,
      },
      id,
    );
  } catch (error) {
    if (isExclusionViolation(error)) {
      return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id);
    }
    throw error;
  }
}

/** Section 7.10 measures this route; see `timedRoute`. */
export const POST = timedRoute("public.booking.reschedule", handlePost);
