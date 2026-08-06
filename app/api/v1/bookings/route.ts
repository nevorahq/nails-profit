import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";

import { bookingLines, bookingStatus, bookings } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { toZonedParts } from "@/domain/timezone";
import {
  alternativeSlots,
  assertAssignable,
  describeAlternatives,
  loadBookingDraft,
  loadSlotContext,
} from "@/lib/availability-service";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnSpecialist, scopedSpecialistId } from "@/lib/booking-access";
import { bookingModuleRefusal, bookingPayload } from "@/lib/booking-http";
import { notifyBooking, scheduleBookingReminder } from "@/lib/booking-notifications";
import { bookingLinesOf, createBooking, type BookingStatus } from "@/lib/booking-service";
import { isExclusionViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { claimIdempotencyKey, fingerprintOf, recordIdempotentResult } from "@/lib/idempotency";
import { logEvent } from "@/lib/logger";
import { getActiveMembership } from "@/lib/membership";
import { recordPilotProductEvent } from "@/lib/pilot-events";

/**
 * Bookings taken by staff, roadmap sections 7.2 and 7.6.
 *
 * Availability, the conflict check and the write happen inside one transaction
 * and one advisory lock (see `lib/booking-service.ts`): a check that commits
 * separately from the write it authorises has authorised nothing.
 *
 * Staff may book outside the published grid. The public page offers slots on a
 * step and inside a lead time; a receptionist squeezing in a regular at 17:40
 * is not doing something wrong, and the rule that actually matters — nobody is
 * booked twice — is enforced regardless.
 */
const createBookingSchema = z.object({
  location_id: z.uuid(),
  specialist_id: z.uuid(),
  service_id: z.uuid(),
  add_on_ids: z.array(z.uuid()).max(20).default([]),
  client_id: z.uuid().nullable().optional(),
  workplace_id: z.uuid().nullable().optional(),
  starts_at: z.iso.datetime(),
});

const IDEMPOTENCY_SCOPE = "booking.staff_create";

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "bookings", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read bookings", id);
  }
  const disabled = await bookingModuleRefusal(actor.organizationId, id);
  if (disabled) return disabled;

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const requestedSpecialist = url.searchParams.get("specialist_id");
  const location = url.searchParams.get("location_id");
  // Section 7.2: the calendar filters by status, and usually by more than one —
  // "everything still on" is `pending_confirmation` and `confirmed` together.
  // Unknown values are dropped rather than refused, so a stale bookmark shows
  // the calendar instead of an error.
  const statuses = (url.searchParams.get("status")?.split(",") ?? [])
    .map((value) => value.trim())
    .filter((value): value is BookingStatus =>
      (bookingStatus.enumValues as readonly string[]).includes(value),
    );

  const rows = await withTenant(actor.organizationId, async (tx) => {
    // Section 6.1: a Master sees their own calendar, resolved from the linked
    // specialist row rather than from a query parameter the caller controls.
    const ownSpecialistId = await scopedSpecialistId(tx, actor);

    const conditions = [
      from ? gte(bookings.startsAt, new Date(from)) : undefined,
      to ? lte(bookings.startsAt, new Date(to)) : undefined,
      ownSpecialistId
        ? eq(bookings.specialistId, ownSpecialistId)
        : requestedSpecialist
          ? eq(bookings.specialistId, requestedSpecialist)
          : undefined,
      location ? eq(bookings.locationId, location) : undefined,
      statuses.length > 0 ? inArray(bookings.status, statuses) : undefined,
    ].filter(Boolean);

    const found = await tx
      .select()
      .from(bookings)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(bookings.startsAt));

    const lines =
      found.length === 0
        ? []
        : await tx
            .select()
            .from(bookingLines)
            .where(
              inArray(
                bookingLines.bookingId,
                found.map((booking) => booking.id),
              ),
            );

    return { found, lines };
  });

  return apiSuccess(
    rows.found.map((booking) =>
      bookingPayload(
        booking,
        rows.lines.filter((line) => line.bookingId === booking.id),
      ),
    ),
    id,
  );
}

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "bookings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot create bookings", id);
  }
  const disabled = await bookingModuleRefusal(actor.organizationId, id);
  if (disabled) return disabled;

  // Section 7.5 requires the key on staff create. Required rather than
  // optional: a retry that silently books a second appointment is the failure
  // this endpoint is most likely to produce in the field.
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return apiError(422, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header is required", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = createBookingSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const now = new Date();
  const startsAt = new Date(parsed.data.starts_at);
  const fingerprint = fingerprintOf(parsed.data);

  try {
    const outcome = await withTenant(actor.organizationId, async (tx) => {
      const claim = await claimIdempotencyKey(tx, {
        organizationId: actor.organizationId,
        scope: IDEMPOTENCY_SCOPE,
        key: idempotencyKey,
        fingerprint,
      });

      if (claim.status === "conflict") return { failure: "IDEMPOTENCY_CONFLICT" as const };
      if (claim.status === "replay") return { replay: claim.bookingId };

      if (!(await mayActOnSpecialist(tx, actor, parsed.data.specialist_id))) {
        return { failure: "FORBIDDEN_SPECIALIST" as const };
      }

      const context = await loadSlotContext(tx, parsed.data.location_id);
      if (!context) return { failure: "LOCATION_NOT_FOUND" as const };

      const assignable = await assertAssignable(tx, {
        specialistId: parsed.data.specialist_id,
        locationId: parsed.data.location_id,
        serviceId: parsed.data.service_id,
      });
      if (assignable !== "ok") return { failure: assignable };

      const draft = await loadBookingDraft(tx, {
        serviceId: parsed.data.service_id,
        addOnIds: parsed.data.add_on_ids,
        specialistId: parsed.data.specialist_id,
      });
      if (!draft) return { failure: "SERVICE_NOT_BOOKABLE" as const };

      const interval = {
        start: startsAt,
        end: new Date(startsAt.getTime() + draft.durationMinutes * 60_000),
      };

      const created = await createBooking(tx, {
        organizationId: actor.organizationId,
        locationId: parsed.data.location_id,
        specialistId: parsed.data.specialist_id,
        workplaceId: parsed.data.workplace_id ?? null,
        clientId: parsed.data.client_id ?? null,
        interval,
        source: "staff",
        // Staff bookings are agreed with the client on the spot, so they are
        // confirmed whatever the public page's confirmation mode is.
        confirmationMode: "instant",
        confirmationTtlMinutes: context.confirmationTtlMinutes,
        lines: draft.lines,
        actorUserId: actor.userId,
        now,
      });

      if (!created.ok) {
        const local = toZonedParts(startsAt, context.timezone);
        const alternatives = await alternativeSlots(
          tx,
          {
            locationId: parsed.data.location_id,
            specialistId: parsed.data.specialist_id,
            durationMinutes: draft.durationMinutes,
            date: { year: local.year, month: local.month, day: local.day },
            now,
          },
          context,
        );
        return { failure: "SLOT_UNAVAILABLE" as const, conflict: created.conflict, alternatives };
      }

      await recordIdempotentResult(tx, claim.id, created.bookingId);

      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "booking.created",
        entityType: "booking",
        entityId: created.bookingId,
        after: {
          specialist_id: parsed.data.specialist_id,
          starts_at: interval.start,
          ends_at: interval.end,
          source: "staff",
        },
        requestId: id,
      });

      await recordPilotProductEvent(tx, {
        organizationId: actor.organizationId,
        eventName: "booking_started",
        actorUserId: actor.userId,
        actorRole: actor.role,
        source: "api",
        entityType: "booking",
        entityId: created.bookingId,
      });
      if (created.status === "confirmed") {
        await recordPilotProductEvent(tx, {
          organizationId: actor.organizationId,
          eventName: "booking_confirmed",
          actorUserId: actor.userId,
          actorRole: actor.role,
          source: "api",
          entityType: "booking",
          entityId: created.bookingId,
        });
      }

      // A booking made at the desk is still an appointment the client should
      // have in writing, with the link that lets them move it without calling.
      await notifyBooking(tx, {
        organizationId: actor.organizationId,
        bookingId: created.bookingId,
        template: "booking.confirmed",
      });
      await scheduleBookingReminder(tx, {
        organizationId: actor.organizationId,
        bookingId: created.bookingId,
        locationId: parsed.data.location_id,
        startsAt: interval.start,
        now,
      });

      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, created.bookingId)).limit(1);
      return { booking, lines: await bookingLinesOf(tx, created.bookingId) };
    });

    if ("replay" in outcome) {
      // The same request, answered again with the same result rather than a
      // second appointment.
      return apiSuccess({ id: outcome.replay, replayed: true }, id);
    }

    if ("failure" in outcome) {
      switch (outcome.failure) {
        case "IDEMPOTENCY_CONFLICT":
          return apiError(409, "IDEMPOTENCY_KEY_REUSED", "This key was used for a different request", id);
        case "FORBIDDEN_SPECIALIST":
          return apiError(403, "FORBIDDEN", "This role may only book its own calendar", id);
        case "LOCATION_NOT_FOUND":
          return apiError(404, "LOCATION_NOT_FOUND", "No bookable location with this ID", id);
        case "specialist_not_found":
          return apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", id);
        case "not_at_location":
          return apiError(422, "SPECIALIST_NOT_AT_LOCATION", "The specialist does not work here", id);
        case "service_not_offered":
          return apiError(422, "SERVICE_NOT_OFFERED", "The specialist does not perform this service", id);
        case "SERVICE_NOT_BOOKABLE":
          return apiError(422, "SERVICE_NOT_BOOKABLE", "The service has no bookable duration", id);
        case "SLOT_UNAVAILABLE":
          logEvent(
            "info",
            "booking.slot_conflict",
            { requestId: id, organizationId: actor.organizationId, userId: actor.userId },
            { conflict: outcome.conflict },
          );
          // Section 7.5: a conflict answers with alternatives. Losing the race
          // is when a client is likeliest to give up, so the response has to
          // contain the next thing to do.
          return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id, {
            details: { conflict: outcome.conflict, alternatives: describeAlternatives(outcome.alternatives) },
          });
      }
    }

    return apiSuccess(bookingPayload(outcome.booking, outcome.lines), id, 201);
  } catch (error) {
    // The exclusion constraint fired: two transactions got past the same check
    // at the same instant. The client sees what it would have seen anyway.
    if (isExclusionViolation(error)) {
      logEvent(
        "warn",
        "booking.exclusion_violation",
        { requestId: id, organizationId: actor.organizationId, userId: actor.userId },
        {},
      );
      return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id, {
        details: { conflict: "booking", alternatives: [] },
      });
    }
    throw error;
  }
}
