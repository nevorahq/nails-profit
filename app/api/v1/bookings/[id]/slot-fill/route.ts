import { withTenant } from "@/db/tenant";
import type { AppLocale } from "@/i18n/messages";
import { requireCalendarCaller } from "@/lib/booking-http";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { publishedBookingSlug } from "@/lib/client-return";
import { logEvent } from "@/lib/logger";
import { getActiveMembership } from "@/lib/membership";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { loadSlotFill } from "@/lib/slot-fill";

/**
 * «Освободилось время»: whom to write to about the hour a cancellation gave back.
 *
 * Asked from a cancelled appointment, because that is the moment the studio
 * is looking at the gap. The answer is up to five clients from «Пора позвать»,
 * each with the message already written in their language; nothing is sent
 * and nothing is stored, so there is no way to offer an hour twice by asking
 * twice. The desk edits the text and sends it from its own phone.
 *
 * Writing, not reading, as for `next-slots`: an Analyst may open the calendar
 * but writes to nobody, and a list of numbers is not theirs to read. A Master
 * acts on their own calendar — an appointment of a colleague is answered 404,
 * so the id does not confirm that it exists.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await requireCalendarCaller(id, "write");
  if (!caller.ok) return caller.response;

  const actor = caller.actor;
  const { id: bookingId } = await context.params;
  const now = new Date();

  // The same lookup the guard just made; it is memoized for the request.
  const session = await getActiveMembership();
  const organization = session.session ? session.organization : null;

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const bookingSlug = await publishedBookingSlug(tx, {
      slug: organization?.slug ?? null,
      bookingAccess: organization?.bookingAccess ?? "calendar",
    });

    return loadSlotFill(tx, actor, {
      bookingId,
      organization: {
        name: organization?.name ?? "",
        locale: (organization?.locale ?? "ru") as AppLocale,
        bookingSlug,
      },
      now,
    });
  });

  if (!outcome.ok) {
    switch (outcome.failure) {
      case "not_found":
        return apiError(404, "BOOKING_NOT_FOUND", "No booking with this ID", id);
      case "not_cancelled":
        return apiError(409, "BOOKING_NOT_CANCELLED", "Only a cancelled appointment leaves an hour to offer", id);
      case "in_past":
        return apiError(409, "BOOKING_IN_PAST", "The cancelled appointment has already begun", id);
      case "slot_taken":
        return apiError(409, "SLOT_UNAVAILABLE", "The hour has been booked again", id);
    }
  }

  const { offer } = outcome;

  /*
   * Counted once per appointment, after the answer is known and in a
   * transaction of its own: a read-only preview or a failed insert must not
   * take the list away from a desk that asked for it.
   */
  try {
    await withTenant(actor.organizationId, (tx) =>
      recordPilotProductEvent(tx, {
        organizationId: actor.organizationId,
        eventName: "slot_fill_opened",
        actorUserId: actor.userId,
        actorRole: actor.role,
        source: "api",
        entityType: "booking",
        entityId: offer.bookingId,
        metadata: { clients: offer.rows.length, has_booking_page: offer.bookingSlug !== null },
      }),
    );
  } catch (error) {
    logEvent("warn", "slot_fill.event_failed", { requestId: id, organizationId: actor.organizationId }, {
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
  const bookingPath = offer.bookingSlug ? `/book/${offer.bookingSlug}` : null;

  return apiSuccess(
    {
      booking_id: offer.bookingId,
      starts_at: offer.startsAt.toISOString(),
      timezone: offer.timezone,
      specialist_name: offer.specialistName,
      // The browser knows the host the studio was reached on and the server
      // does not reliably, so the message carries a token and the page this.
      booking_path: bookingPath,
      clients: offer.rows.map((row) => ({
        client_id: row.clientId,
        name: row.name,
        phone: row.phone,
        channels: row.channels,
        last_visit_day: row.lastVisitDay,
        interval_days: row.intervalDays,
        days_since_last_visit: row.daysSinceLastVisit,
        message: row.message,
      })),
    },
    id,
  );
}
