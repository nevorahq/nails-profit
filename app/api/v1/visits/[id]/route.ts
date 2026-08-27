import { desc, eq } from "drizzle-orm";

import { financialSnapshots, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Deleting a visit.
 *
 * The exception in a product that otherwise never deletes anything about money:
 * a booking is cancelled, an address with history is archived, a member's
 * account outlives their membership. A visit recorded by hand is the one thing
 * with no other way back — it is closed in one step, from a form, and a
 * mistyped one has until now stayed in every total forever. `POST
 * /visits/{id}/adjust` corrects the figures inside a visit that did happen; it
 * has no answer for a visit that did not.
 *
 * What goes with it is the point rather than a side effect: `visit_line` and
 * `financial_snapshot` are `ON DELETE cascade`, so the revenue, the margin and
 * the commission leave the month's totals along with the row. That is why this
 * is the organization-wide scope and not a Master's own — a figure disappearing
 * from the studio's report is the owner's decision.
 *
 * A visit that closed an appointment is refused. `completed` is terminal in
 * `BOOKING_TRANSITIONS`, so the booking cannot go back to `confirmed` to be
 * closed again, and deleting the visit under it would leave an appointment
 * marked completed with nothing behind it — the state
 * `POST /bookings/{id}/complete` already reports as broken. Those are corrected
 * with `adjust`, not removed.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "bookings")) {
    return apiError(403, "FORBIDDEN", "This role cannot delete visits", id);
  }

  const { id: visitId } = await context.params;

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const [visit] = await tx.select().from(visits).where(eq(visits.id, visitId)).limit(1);
    if (!visit) return { failure: "not_found" as const };
    if (visit.bookingId) return { failure: "from_booking" as const };

    /*
     * Read before the delete, and kept whole: the audit event is the only place
     * this visit exists afterwards, so what it earned has to be answerable from
     * the event alone.
     */
    const [snapshot] = await tx
      .select()
      .from(financialSnapshots)
      .where(eq(financialSnapshots.visitId, visit.id))
      .orderBy(desc(financialSnapshots.snapshotVersion))
      .limit(1);

    await tx.delete(visits).where(eq(visits.id, visit.id));

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "visit.deleted",
      entityType: "visit",
      entityId: visit.id,
      before: {
        specialist_id: visit.specialistId,
        client_id: visit.clientId,
        service_id: visit.serviceId,
        completed_at: visit.completedAt.toISOString(),
        status: visit.status,
        currency: visit.currency,
        revenue_minor: snapshot?.revenueMinor ?? null,
        contribution_margin_minor: snapshot?.contributionMarginMinor ?? null,
        commission_minor: snapshot?.commissionMinor ?? null,
      },
      after: null,
      requestId: id,
    });

    return { deleted: visit.id };
  });

  if ("failure" in outcome) {
    if (outcome.failure === "not_found") {
      return apiError(404, "VISIT_NOT_FOUND", "No visit with this ID", id);
    }
    return apiError(
      409,
      "VISIT_FROM_BOOKING",
      "This visit closed an appointment and can only be adjusted",
      id,
    );
  }

  return apiSuccess({ id: outcome.deleted }, id);
}
