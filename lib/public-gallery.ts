import { and, desc, eq, isNull } from "drizzle-orm";

import { galleryPhotos, services, specialists, visitPhotos, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { findPublicOrganization } from "@/lib/public-booking";

/** How many tiles the booking page carries; the newest ones. */
export const PUBLIC_GALLERY_LIMIT = 12;

export type PublicGalleryPhoto = Readonly<{
  id: string;
  url: string;
  width: number;
  height: number;
  /** For the caption and for «book this master»; null when the master was removed since. */
  specialistId: string | null;
  specialistName: string | null;
  serviceName: string | null;
}>;

export function publicGalleryUrl(slug: string, galleryPhotoId: string) {
  return `/api/v1/public/booking/${slug}/gallery/${galleryPhotoId}`;
}

/**
 * The studio's published photos of work, newest first, for the booking page.
 *
 * A photo of a master who has been archived is left out with them: the page
 * would otherwise show work of somebody a client can no longer book. A photo
 * whose service was deleted stays — it is still the studio's work — and simply
 * has no service in its caption.
 */
export async function loadPublicGallery(slug: string): Promise<PublicGalleryPhoto[]> {
  const organization = await findPublicOrganization(slug);
  if (!organization) return [];

  const rows = await withTenant(organization.id, (tx) =>
    tx
      .select({
        id: galleryPhotos.id,
        width: visitPhotos.width,
        height: visitPhotos.height,
        specialistId: specialists.id,
        specialistName: specialists.name,
        serviceName: services.name,
      })
      .from(galleryPhotos)
      .innerJoin(visitPhotos, eq(visitPhotos.id, galleryPhotos.visitPhotoId))
      .innerJoin(visits, eq(visits.id, visitPhotos.visitId))
      .innerJoin(specialists, and(eq(specialists.id, visits.specialistId), isNull(specialists.archivedAt)))
      .leftJoin(services, eq(services.id, visits.serviceId))
      .orderBy(desc(galleryPhotos.createdAt), desc(galleryPhotos.id))
      .limit(PUBLIC_GALLERY_LIMIT),
  );

  return rows.map((row) => ({
    id: row.id,
    url: publicGalleryUrl(organization.slug, row.id),
    width: row.width,
    height: row.height,
    specialistId: row.specialistId,
    specialistName: row.specialistName,
    serviceName: row.serviceName
      ? resolveLocalizedText(row.serviceName, organization.locale, organization.locale)
      : null,
  }));
}

/**
 * Where one published photo's bytes are, or null when it is not on the page:
 * never published, taken down, or its master archived. The route that serves
 * it asks this and nothing else — a photo is public only as long as a row here
 * says so.
 */
export async function loadPublicGalleryObject(slug: string, galleryPhotoId: string) {
  const organization = await findPublicOrganization(slug);
  if (!organization) return null;

  const [row] = await withTenant(organization.id, (tx) =>
    tx
      .select({ storagePath: visitPhotos.storagePath, mimeType: visitPhotos.mimeType })
      .from(galleryPhotos)
      .innerJoin(visitPhotos, eq(visitPhotos.id, galleryPhotos.visitPhotoId))
      .innerJoin(visits, eq(visits.id, visitPhotos.visitId))
      .innerJoin(specialists, and(eq(specialists.id, visits.specialistId), isNull(specialists.archivedAt)))
      .where(eq(galleryPhotos.id, galleryPhotoId))
      .limit(1),
  );
  return row ?? null;
}
