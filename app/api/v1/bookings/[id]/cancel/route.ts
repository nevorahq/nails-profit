import { z } from "zod";

import { applyStaffTransition } from "@/lib/booking-actions";
import { bookingPayload, mutationFailureResponse, requireCalendarCaller } from "@/lib/booking-http";
import { STAFF_CANCELLATION_REASONS } from "@/lib/booking-service";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";

/**
 * Calling off an appointment, roadmap section 7.6.
 *
 * The reason is a code from a closed list rather than free text. Section 7.9
 * keeps PII out of booking columns, and a free-text field on a form a
 * receptionist fills in while on the phone with a client is where a phone
 * number or a diagnosis ends up.
 */
const cancelSchema = z.object({
  reason: z.enum(STAFF_CANCELLATION_REASONS),
  /** Who asked for it; the studio and the client are different numbers. */
  cancelled_by: z.enum(["client", "staff"]).default("staff"),
  version: z.int().positive().optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "write");
  if (!caller.ok) return caller.response;

  const body = await request.json().catch(() => null);
  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id: bookingId } = await context.params;
  const outcome = await applyStaffTransition(
    caller.actor,
    bookingId,
    {
      to: "cancelled",
      auditEventType: "booking.cancelled",
      productEvent: "booking_cancelled",
      cancelledBy: parsed.data.cancelled_by,
      reason: parsed.data.reason,
      expectedVersion: parsed.data.version ?? null,
    },
    id,
  );

  if (!outcome.ok) return mutationFailureResponse(outcome, id);
  return apiSuccess(bookingPayload(outcome.booking, outcome.lines), id);
}
