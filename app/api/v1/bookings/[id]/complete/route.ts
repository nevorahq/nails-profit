import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { toMilliUnits } from "@/domain/units";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { bookingPayload, mutationFailureResponse, requireCalendarCaller } from "@/lib/booking-http";
import { cancelPendingNotifications } from "@/lib/booking-notifications";
import { bookingLinesOf, loadBooking, transitionBooking } from "@/lib/booking-service";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { recordCompletedVisit, VISIT_FAILURES } from "@/lib/visit-service";

/**
 * Closing an appointment into a visit, roadmap section 7.6.
 *
 * Section 7.2 asks for this without re-entering anything: "завершить booking в
 * существующий visit flow без повторного ввода услуги, клиента и мастера". The
 * service, add-ons, specialist and client come from the booking's own lines,
 * and the visit is built by the same function the manual flow uses — Gate 7
 * requires the two to produce identical financial snapshots, and the only way
 * to guarantee that is for there to be one code path.
 *
 * What still has to be supplied is what only the appointment itself knows: how
 * long it actually took and how much material was actually used.
 */
const completeSchema = z.object({
  completed_at: z.iso.datetime().optional(),
  actual_duration_minutes: z.int().positive().nullable().optional(),
  consumption: z
    .array(z.object({ material_id: z.uuid(), actual_quantity: z.number().min(0) }))
    .max(100)
    .default([]),
  version: z.int().positive().optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "write");
  if (!caller.ok) return caller.response;

  const actor = caller.actor;
  const body = await request.json().catch(() => ({}));
  const parsed = completeSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id: bookingId } = await context.params;
  const now = new Date();
  const completedAt = parsed.data.completed_at ? new Date(parsed.data.completed_at) : now;

  try {
    const outcome = await withTenant(actor.organizationId, async (tx) => {
      const existing = await loadBooking(tx, bookingId);
      if (!existing) return { ok: false as const, failure: "not_found" as const };
      if (!(await mayActOnSpecialist(tx, actor, existing.specialistId))) {
        return { ok: false as const, failure: "not_found" as const };
      }

      const lines = await bookingLinesOf(tx, existing.id);
      const service = lines.find((line) => line.kind === "service");
      if (!service?.serviceId) {
        // The catalogue row is gone. The booking keeps its own name and price,
        // but a visit needs the recipe and the commission rule behind them, and
        // guessing which service it used to be would be worse than refusing.
        return { ok: false as const, failure: "service_not_found" as const };
      }

      const moved = await transitionBooking(tx, {
        bookingId: existing.id,
        to: "completed",
        expectedVersion: parsed.data.version ?? null,
        actorUserId: actor.userId,
        now,
      });
      if (!moved.ok) return moved;

      const recorded = await recordCompletedVisit(tx, {
        organizationId: actor.organizationId,
        actor: { userId: actor.userId, role: actor.role },
        serviceId: service.serviceId,
        specialistId: existing.specialistId,
        clientId: existing.clientId,
        addOnIds: lines.filter((line) => line.addOnId).map((line) => line.addOnId!),
        bookingId: existing.id,
        completedAt,
        actualDurationMinutes: parsed.data.actual_duration_minutes ?? null,
        consumption: parsed.data.consumption.map((entry) => ({
          materialId: entry.material_id,
          actualQuantityMilliUnits: toMilliUnits(entry.actual_quantity),
        })),
        requestId: id,
      });

      // Rolls the status change back with it: a booking marked completed with
      // no visit behind it is worse than one that is still confirmed.
      if (!recorded.ok) return { ok: false as const, failure: recorded.failure };

      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "booking.completed",
        entityType: "booking",
        entityId: moved.booking.id,
        before: { status: existing.status },
        after: { status: moved.booking.status, visit_id: recorded.visit.id },
        requestId: id,
      });

      // The appointment happened; a reminder for it is now a message about the
      // past. Dropped here rather than left for the dispatcher's guard, which
      // would count it as an undeliverable message in section 7.10's numbers.
      await cancelPendingNotifications(tx, moved.booking.id);

      await recordPilotProductEvent(tx, {
        organizationId: actor.organizationId,
        eventName: "booking_completed",
        actorUserId: actor.userId,
        actorRole: actor.role,
        source: "api",
        entityType: "booking",
        entityId: moved.booking.id,
      });

      return { ok: true as const, booking: moved.booking, lines, visit: recorded.visit, snapshot: recorded.snapshot };
    });

    if (!outcome.ok) {
      switch (outcome.failure) {
        case "service_not_found":
        case "missing_commission_rule":
        case "missing_duration": {
          const refusal = VISIT_FAILURES[outcome.failure];
          return apiError(refusal.status, refusal.code, refusal.message, id);
        }
        default:
          return mutationFailureResponse(outcome, id);
      }
    }

    return apiSuccess(
      {
        ...bookingPayload(outcome.booking, outcome.lines),
        visit: {
          id: outcome.visit.id,
          completed_at: outcome.visit.completedAt,
          snapshot: {
            version: outcome.snapshot.snapshotVersion,
            revenue_minor: outcome.snapshot.revenueMinor,
            contribution_margin_minor: outcome.snapshot.contributionMarginMinor,
            profit_per_hour_minor: outcome.snapshot.profitPerHourMinor,
            incomplete_reasons: outcome.snapshot.incompleteReasons,
          },
        },
      },
      id,
      201,
    );
  } catch (error) {
    // The partial unique index on `visit.booking_id`: two requests closed the
    // same appointment at once, and only one visit may exist behind it.
    if (isUniqueViolation(error, "visit_booking_idx")) {
      return apiError(409, "BOOKING_ALREADY_COMPLETED", "This booking already has a visit", id);
    }
    throw error;
  }
}
