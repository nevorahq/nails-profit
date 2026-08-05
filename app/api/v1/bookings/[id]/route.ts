import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { auditEvents, bookings, clients, workplaces } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { hasConstraint } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { bookingPayload, mutationFailureResponse, requireCalendarCaller } from "@/lib/booking-http";
import { bookingLinesOf, loadBooking } from "@/lib/booking-service";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";

/**
 * One appointment: the card staff open from the calendar, and the small edits
 * that do not move it in time (roadmap section 7.6).
 *
 * Moving, confirming, cancelling and closing are separate endpoints, because
 * each has its own preconditions and its own audit event. A PATCH that could do
 * any of them would have to re-derive which one was meant from the shape of the
 * body, and would answer every mistake with the same error.
 */
const patchBookingSchema = z.object({
  /** Attaching a walk-in to a client record, or detaching a wrong match. */
  client_id: z.uuid().nullable().optional(),
  workplace_id: z.uuid().nullable().optional(),
  version: z.int().positive(),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "read");
  if (!caller.ok) return caller.response;

  const actor = caller.actor;
  const { id: bookingId } = await context.params;

  const found = await withTenant(actor.organizationId, async (tx) => {
    const booking = await loadBooking(tx, bookingId);
    if (!booking) return null;
    // Section 6.1 again: a Master opens their own appointments. Checked after
    // the load, so an id belonging to a colleague is a 404 and not a hint that
    // something exists at that address.
    if (!(await mayActOnSpecialist(tx, actor, booking.specialistId))) return null;

    const lines = await bookingLinesOf(tx, booking.id);

    const [client] = booking.clientId
      ? await tx
          .select({
            id: clients.id,
            name: clients.name,
            phone: clients.normalizedPhone,
            email: clients.email,
          })
          .from(clients)
          .where(eq(clients.id, booking.clientId))
          .limit(1)
      : [];

    const [workplace] = booking.workplaceId
      ? await tx
          .select({ id: workplaces.id, name: workplaces.name })
          .from(workplaces)
          .where(eq(workplaces.id, booking.workplaceId))
          .limit(1)
      : [];

    // Section 7.2: "открыть карточку записи с audit history". Who moved this
    // appointment and when is the first question asked when a client disputes
    // one, and it is unanswerable from the booking row alone.
    const history = await tx
      .select({
        id: auditEvents.id,
        eventType: auditEvents.eventType,
        actorUserId: auditEvents.actorUserId,
        after: auditEvents.after,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "booking"), eq(auditEvents.entityId, booking.id)))
      .orderBy(desc(auditEvents.createdAt));

    return { booking, lines, client, workplace, history };
  });

  if (!found) return apiError(404, "BOOKING_NOT_FOUND", "No booking with this ID", id);

  // An Analyst reads client history «без телефонов и email» (section 6.1). The
  // name stays: an appointment with nobody's name on it is not a calendar.
  const hideContacts = hasConstraint(actor.role, "clients", "exclude_pii");

  return apiSuccess(
    {
      ...bookingPayload(found.booking, found.lines),
      client: found.client
        ? {
            id: found.client.id,
            name: found.client.name,
            phone: hideContacts ? null : found.client.phone,
            email: hideContacts ? null : found.client.email,
          }
        : null,
      workplace: found.workplace ? { id: found.workplace.id, name: found.workplace.name } : null,
      history: found.history.map((event) => ({
        id: event.id,
        event_type: event.eventType,
        actor_user_id: event.actorUserId,
        details: event.after,
        created_at: event.createdAt,
      })),
    },
    id,
  );
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "write");
  if (!caller.ok) return caller.response;

  const actor = caller.actor;
  const body = await request.json().catch(() => null);
  const parsed = patchBookingSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id: bookingId } = await context.params;
  const now = new Date();

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const booking = await loadBooking(tx, bookingId);
    if (!booking) return { ok: false as const, failure: "not_found" as const };
    if (!(await mayActOnSpecialist(tx, actor, booking.specialistId))) {
      return { ok: false as const, failure: "not_found" as const };
    }
    if (booking.version !== parsed.data.version) {
      return { ok: false as const, failure: "version_conflict" as const, current: booking.version };
    }

    const [updated] = await tx
      .update(bookings)
      .set({
        ...(parsed.data.client_id !== undefined ? { clientId: parsed.data.client_id } : {}),
        ...(parsed.data.workplace_id !== undefined ? { workplaceId: parsed.data.workplace_id } : {}),
        updatedAt: now,
        updatedBy: actor.userId,
        version: booking.version + 1,
      })
      // The version is matched here rather than trusted from the read above:
      // two people editing the same card lose the race in the database, which
      // is the only place both of them are.
      .where(and(eq(bookings.id, booking.id), eq(bookings.version, booking.version)))
      .returning();

    if (!updated) {
      return { ok: false as const, failure: "version_conflict" as const, current: booking.version };
    }

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "booking.updated",
      entityType: "booking",
      entityId: updated.id,
      before: { client_id: booking.clientId, workplace_id: booking.workplaceId },
      after: { client_id: updated.clientId, workplace_id: updated.workplaceId },
      requestId: id,
    });

    return { ok: true as const, booking: updated, lines: await bookingLinesOf(tx, updated.id) };
  });

  if (!outcome.ok) return mutationFailureResponse(outcome, id);
  return apiSuccess(bookingPayload(outcome.booking, outcome.lines), id);
}
