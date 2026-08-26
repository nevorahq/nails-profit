import { withTenant } from "@/db/tenant";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { requireCalendarCaller } from "@/lib/booking-http";
import { bookingLinesOf, loadBooking } from "@/lib/booking-service";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { buildVisitDraft, calculateVisitDraftProfit } from "@/lib/visit-service";

/**
 * What an appointment would earn if it were closed now.
 *
 * Calls `buildVisitDraft` in read-only mode — no rows are written — so the
 * calendar can show the margin before the master commits to it, costed by
 * exactly the code that will cost the visit afterwards. A second, UI-only
 * formula here is the one thing this endpoint exists to prevent.
 *
 * This answered on `/recipe` until the material engine was removed, when the
 * quantities it mostly existed to pre-fill stopped existing. The margin was
 * always the other half of it, and is what is left.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "read");
  if (!caller.ok) return caller.response;

  const actor = caller.actor;
  const { id: bookingId } = await context.params;

  const result = await withTenant(actor.organizationId, async (tx) => {
    const booking = await loadBooking(tx, bookingId);
    if (!booking) return null;
    if (!(await mayActOnSpecialist(tx, actor, booking.specialistId))) return null;

    const lines = await bookingLinesOf(tx, booking.id);
    const service = lines.find((line) => line.kind === "service");

    // The service is gone from the catalogue, so there is no commission rule to
    // resolve and no duration to divide by. Named rather than guessed at.
    const unknown = {
      durationMinutes: 0,
      preview: { status: "incomplete" as const, reasons: ["missing_commission_rule"] },
    };
    if (!service?.serviceId) return unknown;

    const draft = await buildVisitDraft(tx, {
      serviceId: service.serviceId,
      addOnIds: lines.filter((line) => line.addOnId).map((line) => line.addOnId!),
      specialistId: booking.specialistId,
      at: new Date(),
    });
    if (!draft) return unknown;

    const profit = calculateVisitDraftProfit(draft);

    return {
      durationMinutes: draft.plannedDurationMinutes,
      preview:
        profit?.status === "complete"
          ? {
              status: "complete" as const,
              commission_minor: profit.costing.commissionMinor,
              contribution_margin_minor: profit.costing.contributionMarginMinor,
            }
          : {
              status: "incomplete" as const,
              reasons: profit?.status === "incomplete" ? profit.reasons : ["missing_commission_rule"],
            },
    };
  });

  if (!result) return apiError(404, "BOOKING_NOT_FOUND", "No booking with this ID", id);

  return apiSuccess(result, id);
}
