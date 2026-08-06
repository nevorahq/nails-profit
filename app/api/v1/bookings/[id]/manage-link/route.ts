import { withTenant } from "@/db/tenant";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { mutationFailureResponse, requireCalendarCaller } from "@/lib/booking-http";
import { issueManageLink } from "@/lib/booking-manage-link";
import { notifyBooking } from "@/lib/booking-notifications";
import { loadBooking } from "@/lib/booking-service";
import { apiError, apiSuccess, requestId } from "@/lib/http";

/**
 * A fresh manage link for a client who lost theirs — section 7.7's "ссылка
 * управления перевыпущена".
 *
 * The studio is the only party that can ask for this. A client without the link
 * has nothing to authenticate with, and an endpoint that reissued a link on a
 * phone number would be a way to have someone else's appointment sent to you.
 *
 * The response deliberately contains no token: it goes to the client through
 * the same outbox as every other message, so the link travels only to the
 * contact already on the booking, and never through a staff member's screen.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "write");
  if (!caller.ok) return caller.response;

  const { id: bookingId } = await context.params;
  const now = new Date();

  const outcome = await withTenant(caller.actor.organizationId, async (tx) => {
    const booking = await loadBooking(tx, bookingId);
    if (!booking) return { ok: false as const, failure: "not_found" as const };
    if (!(await mayActOnSpecialist(tx, caller.actor, booking.specialistId))) {
      return { ok: false as const, failure: "not_found" as const };
    }
    if (!booking.clientId) return { ok: false as const, failure: "no_client" as const };

    await issueManageLink(tx, {
      organizationId: caller.actor.organizationId,
      bookingId: booking.id,
      now,
    });
    const channels = await notifyBooking(tx, {
      organizationId: caller.actor.organizationId,
      bookingId: booking.id,
      template: "booking.link_reissued",
      // Every reissue is its own message; the same key would silently drop the
      // second request from a client who asked twice.
      occurrence: String(now.getTime()),
    });
    if (channels.length === 0) return { ok: false as const, failure: "no_client" as const };

    await recordAuditEvent(tx, {
      organizationId: caller.actor.organizationId,
      actorUserId: caller.actor.userId,
      eventType: "booking.manage_link_reissued",
      entityType: "booking",
      entityId: booking.id,
      after: { channels },
      requestId: id,
    });

    return { ok: true as const, channels };
  });

  if (!outcome.ok) {
    if (outcome.failure === "no_client") {
      return apiError(422, "NO_CLIENT_CONTACT", "This booking has no contactable client", id);
    }
    return mutationFailureResponse(outcome, id);
  }

  return apiSuccess({ sent_to: outcome.channels }, id);
}
