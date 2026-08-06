import { apiSuccess } from "@/lib/http";
import { withTenant } from "@/db/tenant";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { loadPublicProfile } from "@/lib/public-booking";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_READ_RULE } from "@/lib/rate-limit";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { id, refused } = publicRequest(request, PUBLIC_BOOKING_READ_RULE, "public_booking.profile");
  if (refused) return refused;

  const { slug } = await params;
  const profile = await loadPublicProfile(slug);
  if (!profile) return publicNotFound(id);
  await withTenant(profile.organization.id, (tx) =>
    recordPilotProductEvent(tx, {
      organizationId: profile.organization.id,
      eventName: "booking_page_viewed",
      actorUserId: null,
      actorRole: null,
      source: "api",
      entityType: "organization",
      entityId: profile.organization.id,
    }),
  );
  return apiSuccess(profile.dto, id);
}
