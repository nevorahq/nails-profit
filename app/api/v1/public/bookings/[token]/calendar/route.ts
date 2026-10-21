import { getPublicAppUrl } from "@/env";
import { getTranslator } from "@/i18n/t";
import { loadPublicBookingAccess } from "@/lib/public-booking-access";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_MANAGE_RULE } from "@/lib/rate-limit";
import { visitEvent, visitIcs } from "@/lib/visit-calendar";

/**
 * The appointment as an `.ics` file, for the client's own calendar.
 *
 * Served rather than built in the browser because of the iPhone: Safari offers
 * «Add to Calendar» for a `text/calendar` response, and saves a generated
 * download to Files instead, where nobody finds it.
 *
 * Only an appointment still ahead is offered. A cancelled or finished one has
 * no place in a calendar, and the manage page shows no button for it either.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { id, refused } = await publicRequest(request, PUBLIC_BOOKING_MANAGE_RULE, "public_booking.manage");
  if (refused) return refused;

  const { token } = await params;
  const access = await loadPublicBookingAccess(token);
  if (!access) return publicNotFound(id);
  const { status } = access.booking;
  if (status !== "confirmed" && status !== "pending_confirmation") return publicNotFound(id);

  const origin = getPublicAppUrl() || new URL(request.url).origin;
  const event = visitEvent(
    access.dto,
    getTranslator(access.dto.locale),
    `${origin}/booking/${encodeURIComponent(token)}`,
  );
  return new Response(visitIcs(event, access.booking.id), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'attachment; filename="visit.ics"',
      "cache-control": "private, no-store",
      "x-request-id": id,
    },
  });
}
