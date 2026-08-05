import type { bookingLines } from "@/db/schema";
import { can, type MemberRole } from "@/domain/rbac";
import { apiError } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import type { BookingRow, MutationFailure } from "@/lib/booking-service";

/**
 * The preamble every booking endpoint shares, and the refusals they answer with.
 *
 * Seven handlers ask the same three questions before they do anything — is
 * there a session, does it belong to an organization, does the role hold
 * `bookings` — and answer conflicts from `lib/booking-service.ts` in the same
 * four ways. Written out per handler, the seventh one is where a check quietly
 * goes missing.
 */
export type CalendarCaller = Readonly<{
  organizationId: string;
  userId: string;
  role: MemberRole;
}>;

export type CallerResult =
  | Readonly<{ ok: true; actor: CalendarCaller }>
  | Readonly<{ ok: false; response: Response }>;

export async function requireCalendarCaller(
  requestIdentifier: string,
  action: "read" | "write",
): Promise<CallerResult> {
  const caller = await getActiveMembership();

  if (!caller.session) {
    return {
      ok: false,
      response: apiError(401, "UNAUTHENTICATED", "Authentication is required", requestIdentifier),
    };
  }
  if (!caller.membership) {
    return {
      ok: false,
      response: apiError(
        404,
        "MEMBERSHIP_NOT_FOUND",
        "User does not belong to an organization",
        requestIdentifier,
      ),
    };
  }
  if (!can(caller.membership.role, "bookings", action)) {
    return {
      ok: false,
      response: apiError(
        403,
        "FORBIDDEN",
        action === "read" ? "This role cannot read bookings" : "This role cannot change bookings",
        requestIdentifier,
      ),
    };
  }

  const { organizationId, userId, role } = caller.membership;
  return { ok: true, actor: { organizationId, userId, role } };
}

/**
 * One booking, as every endpoint that returns one returns it.
 *
 * The list, the card and each mutation answer with the same object, so a client
 * that has just confirmed an appointment can put the response straight back
 * into the calendar it came from without a second request.
 */
export function bookingPayload(
  booking: BookingRow,
  lines: readonly (typeof bookingLines.$inferSelect)[] = [],
) {
  return {
    id: booking.id,
    location_id: booking.locationId,
    specialist_id: booking.specialistId,
    workplace_id: booking.workplaceId,
    client_id: booking.clientId,
    starts_at: booking.startsAt,
    ends_at: booking.endsAt,
    status: booking.status,
    source: booking.source,
    confirmation_due_at: booking.confirmationDueAt,
    confirmed_at: booking.confirmedAt,
    cancelled_at: booking.cancelledAt,
    cancelled_by: booking.cancelledBy,
    cancellation_reason: booking.cancellationReason,
    completed_at: booking.completedAt,
    version: booking.version,
    price_minor: lines.reduce((total, line) => total + line.priceMinor, 0),
    lines: lines.map((line) => ({
      kind: line.kind,
      service_id: line.serviceId,
      add_on_id: line.addOnId,
      name: line.nameSnapshot,
      price_minor: line.priceMinor,
      duration_minutes: line.durationMinutes,
    })),
  };
}

/**
 * Turns a refused mutation into the envelope the client localizes on.
 *
 * A version conflict carries the version that is actually current: the caller's
 * screen is stale, and telling it so without telling it what changed leaves it
 * retrying the same losing request.
 */
export function mutationFailureResponse(failure: MutationFailure, requestIdentifier: string) {
  switch (failure.failure) {
    case "not_found":
      return apiError(404, "BOOKING_NOT_FOUND", "No booking with this ID", requestIdentifier);
    case "version_conflict":
      return apiError(409, "VERSION_CONFLICT", "This booking changed since it was read", requestIdentifier, {
        details: { current_version: failure.current },
      });
    case "illegal_transition":
      return apiError(409, "ILLEGAL_TRANSITION", "A booking in this state cannot do that", requestIdentifier, {
        details: { status: failure.from },
      });
    case "conflict":
      return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", requestIdentifier, {
        details: { conflict: failure.conflict, alternatives: [] },
      });
  }
}
