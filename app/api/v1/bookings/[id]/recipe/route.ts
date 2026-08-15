import { asc, isNull } from "drizzle-orm";

import { materials } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { requireCalendarCaller } from "@/lib/booking-http";
import { bookingLinesOf, loadBooking } from "@/lib/booking-service";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { buildVisitDraft, calculateVisitDraftProfit } from "@/lib/visit-service";

/**
 * Recipe preview for a booking, used to pre-fill the completion form.
 *
 * Calls buildVisitDraft in read-only mode (no rows are written). The response
 * tells the calendar board which materials to show and what their normative
 * quantities are, so the master only needs to correct deviations.
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
    if (!service?.serviceId) {
      return {
        durationMinutes: 0,
        materials: [],
        materialOptions: [],
        preview: {
          status: "incomplete" as const,
          material_cost_minor: null,
          reasons: ["missing_standard_usage"],
        },
      };
    }

    const draft = await buildVisitDraft(tx, {
      serviceId: service.serviceId,
      addOnIds: lines.filter((l) => l.addOnId).map((l) => l.addOnId!),
      specialistId: booking.specialistId,
      at: new Date(),
    });

    if (!draft) {
      return {
        durationMinutes: 0,
        materials: [],
        materialOptions: [],
        preview: {
          status: "incomplete" as const,
          material_cost_minor: null,
          reasons: ["missing_standard_usage"],
        },
      };
    }

    const profit = calculateVisitDraftProfit(draft);
    const materialOptions = await tx
      .select({ id: materials.id, name: materials.name, base_unit: materials.baseUnit })
      .from(materials)
      .where(isNull(materials.archivedAt))
      .orderBy(asc(materials.name));

    return {
      durationMinutes: draft.plannedDurationMinutes,
      materials: draft.consumptions.map((c) => ({
        material_id: c.materialId,
        material_name: c.materialNameSnapshot,
        base_unit: c.baseUnitSnapshot,
        normative_quantity_milli_units: c.normativeQuantityMilliUnits,
      })),
      materialOptions,
      preview:
        profit?.status === "complete"
          ? {
              status: "complete" as const,
              material_cost_minor: profit.costing.materialCostMinor,
              commission_minor: profit.costing.commissionMinor,
              contribution_margin_minor: profit.costing.contributionMarginMinor,
            }
          : {
              status: "incomplete" as const,
              material_cost_minor: profit?.deviation.normativeCostMinor ?? null,
              reasons: profit?.status === "incomplete" ? profit.reasons : ["missing_commission_rule"],
            },
    };
  });

  if (!result) return apiError(404, "BOOKING_NOT_FOUND", "No booking with this ID", id);

  return apiSuccess(result, id);
}
