import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { recordAuditEvent } from "@/lib/audit";
import { cancelPendingNotifications, notifyBooking } from "@/lib/booking-notifications";
import { transitionBooking } from "@/lib/booking-service";
import { apiError, apiSuccess, toFieldErrors, timedRoute } from "@/lib/http";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { loadPublicBookingAccess } from "@/lib/public-booking-access";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_MANAGE_RULE } from "@/lib/rate-limit";

const schema = z.object({ version: z.int().positive() });

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { id, refused } = publicRequest(request, PUBLIC_BOOKING_MANAGE_RULE, "public_booking.cancel");
  if (refused) return refused;
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { token } = await params;
  const access = await loadPublicBookingAccess(token);
  if (!access) return publicNotFound(id);
  const now = new Date();

  const outcome = await withTenant(access.organizationId, async (tx) => {
    const cancelled = await transitionBooking(tx, {
      bookingId: access.booking.id,
      to: "cancelled",
      expectedVersion: parsed.data.version,
      actor: "client",
      reason: "client_request",
      actorUserId: null,
      now,
    });
    if (!cancelled.ok) return cancelled;

    await recordAuditEvent(tx, {
      organizationId: access.organizationId,
      actorUserId: null,
      eventType: "booking.cancelled",
      entityType: "booking",
      entityId: access.booking.id,
      before: { status: access.booking.status },
      after: { status: "cancelled", cancelled_by: "client", cancellation_reason: "client_request" },
      requestId: id,
    });
    await recordPilotProductEvent(tx, {
      organizationId: access.organizationId,
      eventName: "booking_cancelled",
      actorUserId: null,
      actorRole: null,
      source: "api",
      entityType: "booking",
      entityId: access.booking.id,
    });
    await notifyBooking(tx, {
      organizationId: access.organizationId,
      bookingId: access.booking.id,
      template: "booking.cancelled",
      occurrence: String(cancelled.booking.version),
    });
    // Nobody is coming, so nobody is reminded.
    await cancelPendingNotifications(tx, access.booking.id);
    return cancelled;
  });

  if (!outcome.ok) {
    if (outcome.failure === "version_conflict") {
      return apiError(409, "VERSION_CONFLICT", "This booking changed", id, {
        details: { current_version: outcome.current },
      });
    }
    return apiError(409, "ILLEGAL_TRANSITION", "This booking cannot be cancelled", id);
  }
  return apiSuccess({ status: outcome.booking.status, version: outcome.booking.version }, id);
}

/** Section 7.10 measures this route; see `timedRoute`. */
export const POST = timedRoute("public.booking.cancel", handlePost);
