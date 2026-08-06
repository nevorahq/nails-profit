import { z } from "zod";

import { apiError, apiSuccess, toFieldErrors } from "@/lib/http";
import { loadPublicCatalog } from "@/lib/public-booking";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_READ_RULE } from "@/lib/rate-limit";

const querySchema = z.object({ location_id: z.uuid() });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { id, refused } = publicRequest(request, PUBLIC_BOOKING_READ_RULE, "public_booking.catalog");
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
  return apiSuccess(catalogue.dto, id);
}
