import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { apiError, apiSuccess, toFieldErrors } from "@/lib/http";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { loadPublicCatalog } from "@/lib/public-booking";
import { publicNotFound, publicRequest, publicSessionKey } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_READ_RULE } from "@/lib/rate-limit";

const querySchema = z.object({ location_id: z.uuid() });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { id, refused } = await publicRequest(request, PUBLIC_BOOKING_READ_RULE, "public_booking.catalog");
  if (refused) return refused;

  const query = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!query.success) {
    return apiError(422, "VALIDATION_ERROR", "The query is invalid", id, {
      fieldErrors: toFieldErrors(query.error.issues),
    });
  }

  const { slug } = await params;
  const catalogue = await loadPublicCatalog(slug, query.data.location_id);
  if (!catalogue) return publicNotFound(id);

  /**
   * The first step of section 7.10's funnel is recorded here rather than on the
   * profile endpoint, because the page is server-rendered: the request that
   * proves a browser opened it is the catalogue the form fetches on mount, and
   * it is the first one carrying a visit key to count it by.
   */
  const sessionKey = publicSessionKey(request);
  if (sessionKey) {
    await withTenant(catalogue.organization.id, (tx) =>
      recordPilotProductEvent(tx, {
        organizationId: catalogue.organization.id,
        eventName: "booking_page_viewed",
        actorUserId: null,
        actorRole: null,
        source: "api",
        entityType: "organization",
        entityId: catalogue.organization.id,
        sessionKey,
      }),
    );
  }

  return apiSuccess(catalogue.dto, id);
}
