import { apiSuccess } from "@/lib/http";
import { loadPublicProfile } from "@/lib/public-booking";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_READ_RULE } from "@/lib/rate-limit";

/**
 * The studio's public profile: which locations take bookings, in what currency
 * and language.
 *
 * It records no product event. `booking_page_viewed` belongs to the catalogue
 * request, which is what a browser opening the page actually sends — this
 * endpoint is reached by the server render and by API callers, and counting
 * either as a visit would put readers in the funnel who never saw the page.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { id, refused } = await publicRequest(request, PUBLIC_BOOKING_READ_RULE, "public_booking.profile");
  if (refused) return refused;

  const { slug } = await params;
  const profile = await loadPublicProfile(slug);
  if (!profile) return publicNotFound(id);
  return apiSuccess(profile.dto, id);
}
