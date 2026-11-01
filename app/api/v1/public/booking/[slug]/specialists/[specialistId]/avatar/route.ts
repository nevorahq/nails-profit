import { z } from "zod";

import { apiError } from "@/lib/http";
import { loadPublicAvatar } from "@/lib/public-booking";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_READ_RULE } from "@/lib/rate-limit";

/**
 * A master's photo for the booking page, which has no session to show.
 *
 * The staff route answers only to a member of the studio. A client choosing
 * whom to book sees the same face, so this one serves it to anyone — but only
 * for a master the page itself offers (`loadPublicAvatar` decides), and always
 * as an image: the type stored beside the bytes was read from their signature.
 *
 * The URL carries the photo's version, so a replaced picture is a new address
 * and the old one can sit in a shared cache. Revalidation by `etag` covers the
 * address that is reused.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; specialistId: string }> },
) {
  const { id, refused } = await publicRequest(request, PUBLIC_BOOKING_READ_RULE, "public_booking.avatar");
  if (refused) return refused;

  const { slug, specialistId } = await params;
  // Checked before the database is asked: a malformed id is a 404 either way,
  // and `uuid` columns throw on it.
  if (!z.uuid().safeParse(specialistId).success) return publicNotFound(id);

  const etagOnly = await loadPublicAvatar(slug, specialistId, { bytes: false });
  if (!etagOnly) return apiError(404, "NOT_FOUND", "This specialist has no photo", id);

  const etag = `"${etagOnly.version}-${etagOnly.updatedAt.getTime()}"`;
  const headers = {
    etag,
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
    "x-request-id": id,
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const full = await loadPublicAvatar(slug, specialistId, { bytes: true });
  if (!full?.bytes) return apiError(404, "NOT_FOUND", "This specialist has no photo", id);

  return new Response(new Uint8Array(full.bytes), {
    headers: { ...headers, "content-type": full.mimeType, "content-length": String(full.bytes.length) },
  });
}
