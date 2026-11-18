import { z } from "zod";

import { apiError } from "@/lib/http";
import { getPhotoStorage, PhotoStorageError } from "@/lib/photo-storage";
import { loadPublicGalleryObject } from "@/lib/public-gallery";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_READ_RULE } from "@/lib/rate-limit";

/**
 * One photo of the studio's work, for the booking page, which has no session.
 *
 * The address is the publication's, not the photo's: `loadPublicGalleryObject`
 * finds the bytes only while a gallery row says the studio shows them, so
 * taking a photo down closes this address (a link already handed out lives for
 * its hour, no longer). The bucket stays private; a browser is sent to a
 * signed link, or served the bytes where the driver has none to sign.
 *
 * Shared caches may keep the answer a little less than the signed link lives.
 */
const SIGNED_SECONDS = 3_600;
const CACHE = "public, max-age=3000";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; photoId: string }> },
) {
  const { id, refused } = await publicRequest(request, PUBLIC_BOOKING_READ_RULE, "public_booking.gallery");
  if (refused) return refused;

  const { slug, photoId } = await params;
  if (!z.uuid().safeParse(photoId).success) return publicNotFound(id);

  const storage = getPhotoStorage();
  if (!storage) return apiError(404, "NOT_FOUND", "This photo is not available", id);

  const photo = await loadPublicGalleryObject(slug, photoId);
  if (!photo) return apiError(404, "NOT_FOUND", "This photo is not available", id);

  try {
    const signed = await storage.signedUrl(photo.storagePath, SIGNED_SECONDS);
    if (signed) {
      return new Response(null, {
        status: 302,
        headers: { location: signed, "cache-control": CACHE, "x-request-id": id },
      });
    }
    const bytes = await storage.get(photo.storagePath);
    if (!bytes) return apiError(404, "NOT_FOUND", "This photo is not available", id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": photo.mimeType,
        "content-length": String(bytes.length),
        "cache-control": CACHE,
        "x-content-type-options": "nosniff",
        "x-request-id": id,
      },
    });
  } catch (error) {
    if (error instanceof PhotoStorageError) {
      return apiError(502, "PHOTO_STORAGE_FAILED", "The photo could not be read", id);
    }
    throw error;
  }
}
