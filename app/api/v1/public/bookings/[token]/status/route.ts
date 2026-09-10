import { apiSuccess } from "@/lib/http";
import { loadPublicBookingStatus } from "@/lib/public-booking-access";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_POLL_RULE } from "@/lib/rate-limit";

/**
 * What the manage page asks while a client waits.
 *
 * The sibling route beside this one returns the appointment; this returns only
 * whether it is still the one the page is showing. The difference is not the
 * payload but the budget: a person opening their booking spends from
 * `PUBLIC_BOOKING_MANAGE_RULE`, a page checking on their behalf spends from
 * `PUBLIC_BOOKING_POLL_RULE`, and neither can exhaust the other. A client who
 * watched an unanswered request for an hour must still be able to cancel it.
 *
 * `no-store` for the same reason the full route sets it: an appointment's state
 * is the one thing on this page that must never be answered from a cache — the
 * whole point of asking is that it may have changed a second ago.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { id, refused } = await publicRequest(
    request,
    PUBLIC_BOOKING_POLL_RULE,
    "public_booking.status",
  );
  if (refused) return refused;

  const { token } = await params;
  const status = await loadPublicBookingStatus(token);
  if (!status) return publicNotFound(id);

  const response = apiSuccess(status, id);
  response.headers.set("cache-control", "private, no-store");
  return response;
}
