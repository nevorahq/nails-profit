import { z } from "zod";

import { applyStaffTransition } from "@/lib/booking-actions";
import { bookingPayload, mutationFailureResponse, requireCalendarCaller } from "@/lib/booking-http";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";

/**
 * The client did not come, roadmap section 7.6.
 *
 * Separate from cancelling, and deliberately not a kind of it: a no-show is not
 * a slot that was given back, and a studio reading its month needs to tell the
 * two apart. No penalty follows — deposits and no-show fees are explicitly out
 * of scope for Phase 7 — so this only records what happened.
 */
const noShowSchema = z.object({ version: z.int().positive().optional() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "write");
  if (!caller.ok) return caller.response;

  const body = await request.json().catch(() => ({}));
  const parsed = noShowSchema.safeParse(body ?? {});
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
      to: "no_show",
      auditEventType: "booking.no_show",
      productEvent: "booking_no_show",
      expectedVersion: parsed.data.version ?? null,
    },
    id,
  );

  if (!outcome.ok) return mutationFailureResponse(outcome, id);
  return apiSuccess(bookingPayload(outcome.booking, outcome.lines), id);
}
