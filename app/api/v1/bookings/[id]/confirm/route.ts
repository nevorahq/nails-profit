import { z } from "zod";

import { applyStaffTransition } from "@/lib/booking-actions";
import { bookingPayload, mutationFailureResponse, requireCalendarCaller } from "@/lib/booking-http";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";

/**
 * Answering a request the studio received, roadmap section 7.6.
 *
 * Only `pending_confirmation` leads here, and the transition table is what says
 * so: confirming an appointment that was cancelled while the tab was open would
 * put a client back in a calendar they had already been told they were out of.
 */
const confirmSchema = z.object({ version: z.int().positive().optional() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "write");
  if (!caller.ok) return caller.response;

  const body = await request.json().catch(() => ({}));
  const parsed = confirmSchema.safeParse(body ?? {});
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
      to: "confirmed",
      auditEventType: "booking.confirmed",
      productEvent: "booking_confirmed",
      expectedVersion: parsed.data.version ?? null,
    },
    id,
  );

  if (!outcome.ok) return mutationFailureResponse(outcome, id);
  return apiSuccess(bookingPayload(outcome.booking, outcome.lines), id);
}
