import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { financialSnapshots, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { bookingPayload, mutationFailureResponse, requireCalendarCaller } from "@/lib/booking-http";
import { cancelPendingNotifications, notifyVisitCompleted } from "@/lib/booking-notifications";
import { bookingLinesOf, loadBooking, transitionBooking } from "@/lib/booking-service";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { fingerprintOf } from "@/lib/idempotency";
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
 * long it actually took.
 */
const completeSchema = z.object({
  completed_at: z.iso.datetime().optional(),
  actual_duration_minutes: z.int().positive().nullable().optional(),
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
  const completionKey = request.headers.get("idempotency-key")?.trim() || undefined;
  if (completionKey && completionKey.length > 200) {
    return apiError(422, "INVALID_IDEMPOTENCY_KEY", "The idempotency key is too long", id);
  }
  const completionFingerprint = fingerprintOf(parsed.data);

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
        // but a visit needs the commission rule behind them, and guessing which
        // service it used to be would be worse than refusing.
        return { ok: false as const, failure: "service_not_found" as const };
      }

      const loadRecordedVisit = async () => {
        const [visit] = await tx
          .select()
          .from(visits)
          .where(eq(visits.bookingId, existing.id))
          .limit(1);
        if (!visit) return null;
        const [snapshot] = await tx
          .select()
          .from(financialSnapshots)
          .where(eq(financialSnapshots.visitId, visit.id))
          .orderBy(desc(financialSnapshots.snapshotVersion))
          .limit(1);
        return snapshot ? { visit, snapshot } : null;
      };

      // A successful response that was lost on the network is still the same
      // completion. Return the already persisted visit/snapshot instead of
      // attempting another state transition or writing another snapshot.
      if (existing.status === "completed") {
        const recorded = await loadRecordedVisit();
        if (!recorded) return { ok: false as const, failure: "idempotency_conflict" as const };
        if (
          recorded.visit.completionFingerprint !== null &&
          recorded.visit.completionFingerprint !== completionFingerprint
        ) {
          return { ok: false as const, failure: "idempotency_conflict" as const };
        }
        return {
          ok: true as const,
          booking: existing,
          lines,
          ...recorded,
          replayed: true,
        };
      }

      const moved = await transitionBooking(tx, {
        bookingId: existing.id,
        to: "completed",
        expectedVersion: parsed.data.version ?? null,
        actorUserId: actor.userId,
        now,
      });
      if (!moved.ok) {
        // Under READ COMMITTED a racing completion may have committed while
        // the optimistic update waited. Re-read once and turn that race into
        // an idempotent replay when the same payload won.
        const recorded = await loadRecordedVisit();
        if (
          recorded &&
          (recorded.visit.completionFingerprint === null ||
            recorded.visit.completionFingerprint === completionFingerprint)
        ) {
          return {
            ok: true as const,
            booking: (await loadBooking(tx, existing.id)) ?? existing,
            lines,
            ...recorded,
            replayed: true,
          };
        }
        return moved;
      }

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
        requestId: id,
        completionKey,
        completionFingerprint,
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

      // Queued after the cancellation above, not before: that call clears every
      // message still pending for this booking, and the thank-you is the one
      // message the completion creates rather than invalidates.
      await notifyVisitCompleted(tx, {
        organizationId: actor.organizationId,
        bookingId: moved.booking.id,
      });

      await recordPilotProductEvent(tx, {
        organizationId: actor.organizationId,
        eventName: "booking_completed",
        actorUserId: actor.userId,
        actorRole: actor.role,
        source: "api",
        entityType: "booking",
        entityId: moved.booking.id,
      });

      return {
        ok: true as const,
        booking: moved.booking,
        lines,
        visit: recorded.visit,
        snapshot: recorded.snapshot,
        replayed: recorded.replayed,
      };
    });

    if (!outcome.ok) {
      switch (outcome.failure) {
        case "service_not_found":
        case "missing_commission_rule":
        case "missing_duration": {
          const refusal = VISIT_FAILURES[outcome.failure];
          return apiError(refusal.status, refusal.code, refusal.message, id);
        }
        case "idempotency_conflict": {
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
      outcome.replayed ? 200 : 201,
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
