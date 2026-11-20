import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { mutationFailureResponse, requireCalendarCaller } from "@/lib/booking-http";
import {
  cancelPendingNotifications,
  notifyBooking,
  scheduleBookingReminder,
} from "@/lib/booking-notifications";
import { shiftFollowingBookings, ShiftVersionConflict } from "@/lib/booking-shift";
import { isExclusionViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, timedRoute, toFieldErrors } from "@/lib/http";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { recordStaffNotice } from "@/lib/staff-notices";

/**
 * Moving what follows a visit that ran short or long.
 *
 * The id is the visit being corrected, not one of the moved ones. Two steps on
 * one URL: `preview` says what would move and why not, and writes nothing;
 * `apply` is sent with the versions the preview showed, so a day that changed
 * in between is refused rather than rearranged under somebody who was looking at
 * the old one.
 *
 * Four hours is far more than a delay or an early finish ever is, and it keeps
 * a mistyped number from sending the whole afternoon into tomorrow.
 */
const MAX_SHIFT_MINUTES = 240;

const shiftSchema = z.object({
  delta_minutes: z
    .int()
    .min(-MAX_SHIFT_MINUTES)
    .max(MAX_SHIFT_MINUTES)
    .refine((value) => value !== 0, "Must not be zero"),
  mode: z.enum(["preview", "apply"]),
  /** Required to apply: booking id → the version the preview showed. */
  versions: z.record(z.uuid(), z.int().positive()).optional(),
});

async function handlePost(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "write");
  if (!caller.ok) return caller.response;

  const actor = caller.actor;
  const parsed = shiftSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }
  if (parsed.data.mode === "apply" && !parsed.data.versions) {
    return apiError(422, "VALIDATION_ERROR", "Applying a shift needs the versions the preview showed", id, {
      fieldErrors: [{ field: "versions", code: "required", message: "Required" }],
    });
  }

  const { id: anchorId } = await context.params;
  const now = new Date();
  const { delta_minutes: deltaMinutes, mode } = parsed.data;

  try {
    const outcome = await withTenant(actor.organizationId, async (tx) => {
      const result = await shiftFollowingBookings(tx, {
        organizationId: actor.organizationId,
        anchorBookingId: anchorId,
        deltaMinutes,
        expectedVersions: mode === "apply" ? parsed.data.versions : null,
        mode,
        actorUserId: actor.userId,
        now,
      });
      if (!result.ok) return result;

      // The chain is one master's day. Checked after the plan, so a colleague's
      // day is reported as not found rather than described.
      const first = result.moves[0]!.booking;
      if (!(await mayActOnSpecialist(tx, actor, first.specialistId))) {
        return { ok: false as const, failure: "not_found" as const };
      }

      if (mode === "preview") return result;

      // The visit that was corrected is written down too, though nobody is told
      // about it: the client was there, or is the one who ran long.
      if (result.anchor) {
        await recordAuditEvent(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          eventType: "booking.rescheduled",
          entityType: "booking",
          entityId: result.anchor.after.id,
          before: { starts_at: result.anchor.before.start, ends_at: result.anchor.before.end },
          after: { starts_at: result.anchor.after.startsAt, ends_at: result.anchor.after.endsAt },
          requestId: id,
        });
      }

      for (const booking of result.applied) {
        const move = result.moves.find((entry) => entry.id === booking.id)!;

        await recordAuditEvent(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          eventType: "booking.rescheduled",
          entityType: "booking",
          entityId: booking.id,
          before: { starts_at: move.from.start, ends_at: move.from.end, specialist_id: booking.specialistId },
          after: { starts_at: booking.startsAt, ends_at: booking.endsAt, specialist_id: booking.specialistId },
          requestId: id,
        });

        await recordPilotProductEvent(tx, {
          organizationId: actor.organizationId,
          eventName: "booking_rescheduled",
          actorUserId: actor.userId,
          actorRole: actor.role,
          source: "api",
          entityType: "booking",
          entityId: booking.id,
        });

        await recordStaffNotice(tx, {
          organizationId: actor.organizationId,
          bookingId: booking.id,
          kind: "staff_rescheduled",
          specialistId: booking.specialistId,
          actorUserId: actor.userId,
          previousStartsAt: move.from.start,
        });

        // The same message a single move sends: the client agreed to one hour
        // and is expected at another, so SMS stands in where there is no email.
        await notifyBooking(tx, {
          organizationId: actor.organizationId,
          bookingId: booking.id,
          template: "booking.rescheduled",
          occurrence: String(booking.version),
          causedBy: "staff",
        });
        await cancelPendingNotifications(tx, booking.id);
        await scheduleBookingReminder(tx, {
          organizationId: actor.organizationId,
          bookingId: booking.id,
          locationId: booking.locationId,
          startsAt: booking.startsAt,
          now,
        });
      }

      return result;
    });

    if (!outcome.ok) {
      switch (outcome.failure) {
        case "refused":
          return apiError(409, "SHIFT_NOT_POSSIBLE", "The following appointments cannot be moved by this much", id, {
            details: {
              reason: outcome.reason,
              booking_id: "bookingId" in outcome ? outcome.bookingId : null,
            },
          });
        case "conflict":
          return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id, {
            details: { conflict: outcome.conflict, booking_id: outcome.bookingId, alternatives: [] },
          });
        case "version_conflict":
          return apiError(409, "VERSION_CONFLICT", "The day changed since it was read", id);
        case "not_found":
        case "illegal_transition":
          return mutationFailureResponse(outcome, id);
      }
    }

    return apiSuccess(
      {
        mode,
        delta_minutes: deltaMinutes,
        moves: outcome.moves.map((move) => ({
          booking_id: move.id,
          version: move.booking.version,
          from: { starts_at: move.from.start, ends_at: move.from.end },
          to: { starts_at: move.to.start, ends_at: move.to.end },
        })),
      },
      id,
    );
  } catch (error) {
    if (error instanceof ShiftVersionConflict) {
      return apiError(409, "VERSION_CONFLICT", "The day changed while it was being moved", id);
    }
    // Two writers onto one hour at the same instant: the constraint decides.
    if (isExclusionViolation(error)) {
      return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id, {
        details: { conflict: "booking", alternatives: [] },
      });
    }
    throw error;
  }
}

export const POST = timedRoute("staff.booking.shift_following", handlePost);
