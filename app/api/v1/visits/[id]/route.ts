import { and, desc, eq } from "drizzle-orm";

import { bookings, financialSnapshots, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { loadBooking } from "@/lib/booking-service";
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
 * A visit that closed an appointment goes too, and the appointment goes back to
 * `confirmed` in the same transaction. Leaving it `completed` is what used to
 * make this case a refusal: an appointment marked completed with nothing behind
 * it is the state `POST /bookings/{id}/complete` itself reports as broken. So
 * the completion is undone rather than orphaned, and the booking can be closed
 * again — the partial unique index on `visit.booking_id` frees with the row.
 *
 * That reversal is written here, directly, and `BOOKING_TRANSITIONS` still says
 * `completed` is terminal. The distinction is deliberate: `canTransition` is
 * consulted by `transitionBooking`, which serves `POST /bookings/{id}/confirm`
 * among others, so admitting `completed → confirmed` to the table would let
 * staff un-complete an appointment while its visit still stands — the same
 * broken pair, mirrored. The only thing that may reverse a completion is the
 * removal of what the completion produced, and that is atomic with it here.
 *
 * `adjust` remains the usual answer. Correcting the figures in a visit that did
 * happen is not this: this is for one that did not.
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

  const now = new Date();

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const [visit] = await tx.select().from(visits).where(eq(visits.id, visitId)).limit(1);
    if (!visit) return { failure: "not_found" as const };

    /*
     * The appointment first, while nothing has been destroyed yet.
     *
     * A returned failure commits the transaction — only a thrown one rolls it
     * back — so a booking this cannot reopen has to be found before the visit
     * is gone, not after. The version is matched in the `WHERE` clause for the
     * reason `transitionBooking` matches it there: a colleague acting on the
     * same appointment in the same moment read the same row, and only the
     * update that matched may claim to have changed anything.
     */
    const booking = visit.bookingId ? await loadBooking(tx, visit.bookingId) : null;
    if (booking && booking.status === "completed") {
      const [reopened] = await tx
        .update(bookings)
        .set({
          status: "confirmed",
          completedAt: null,
          updatedAt: now,
          updatedBy: actor.userId,
          version: booking.version + 1,
        })
        .where(and(eq(bookings.id, booking.id), eq(bookings.version, booking.version)))
        .returning();
      if (!reopened) return { failure: "booking_conflict" as const };

      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "booking.completion_reversed",
        entityType: "booking",
        entityId: booking.id,
        before: { status: booking.status, visit_id: visit.id },
        after: { status: "confirmed", visit_id: null },
        requestId: id,
      });
    }

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
      "VERSION_CONFLICT",
      "The appointment behind this visit changed while it was open",
      id,
    );
  }

  return apiSuccess({ id: outcome.deleted }, id);
}
