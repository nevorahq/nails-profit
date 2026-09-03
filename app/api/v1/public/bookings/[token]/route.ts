import { apiSuccess } from "@/lib/http";
import { loadPublicBookingAccess } from "@/lib/public-booking-access";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_MANAGE_RULE } from "@/lib/rate-limit";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { id, refused } = await publicRequest(request, PUBLIC_BOOKING_MANAGE_RULE, "public_booking.manage");
  if (refused) return refused;

  const { token } = await params;
  const access = await loadPublicBookingAccess(token);
  if (!access) return publicNotFound(id);
  const response = apiSuccess(access.dto, id);
  response.headers.set("cache-control", "private, no-store");
  return response;
}
