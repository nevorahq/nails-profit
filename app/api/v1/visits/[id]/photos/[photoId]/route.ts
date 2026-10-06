import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { visitPhotos, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnSpecialist, type CalendarActor } from "@/lib/booking-access";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { getPhotoStorage, PhotoStorageError } from "@/lib/photo-storage";
import { flushStorageDeletions, mayHandlePhotos, queuePhotoDeletion } from "@/lib/visit-photos";

/**
 * One photo of work: shown to whoever may see the visit, removed by whoever
 * may change it.
 *
 * The address is the application's, and it is where access is decided: the
 * bucket is private, and what a browser is finally sent to is a signed link
 * that expires within the hour. An `<img>` that outlives a removed master's
 * access stops loading with it.
 */
type Context = { params: Promise<{ id: string; photoId: string }> };

/** How long a signed link lives; the browser may keep the redirect a little less. */
const SIGNED_SECONDS = 3_600;

async function findPhoto(organizationId: string, actor: CalendarActor, visitId: string, photoId: string) {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select({
        storagePath: visitPhotos.storagePath,
        mimeType: visitPhotos.mimeType,
        specialistId: visits.specialistId,
      })
      .from(visitPhotos)
      .innerJoin(visits, eq(visits.id, visitPhotos.visitId))
      .where(and(eq(visitPhotos.id, photoId), eq(visitPhotos.visitId, visitId)))
      .limit(1);
    if (!row || !(await mayActOnSpecialist(tx, actor, row.specialistId))) return null;
    return row;
  });
}

export async function GET(request: Request, context: Context) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  const actor = caller.membership;
  if (!mayHandlePhotos(actor.role, "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot see photos of work", id);
  }

  const { id: visitId, photoId } = await context.params;
  if (!z.uuid().safeParse(visitId).success || !z.uuid().safeParse(photoId).success) {
    return apiError(404, "PHOTO_NOT_FOUND", "No photo with this ID", id);
  }

  const storage = getPhotoStorage();
  if (!storage) return apiError(503, "PHOTOS_NOT_CONFIGURED", "Photo storage is not set up here", id);

  const photo = await findPhoto(actor.organizationId, actor, visitId, photoId);
  if (!photo) return apiError(404, "PHOTO_NOT_FOUND", "No photo with this ID", id);

  try {
    const signed = await storage.signedUrl(photo.storagePath, SIGNED_SECONDS);
    if (signed) {
      return new Response(null, {
        status: 302,
        headers: {
          location: signed,
          // Kept by this browser only, and for less than the link lives.
          "cache-control": "private, max-age=3000",
          "x-request-id": id,
        },
      });
    }

    const bytes = await storage.get(photo.storagePath);
    if (!bytes) return apiError(404, "PHOTO_NOT_FOUND", "No photo with this ID", id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": photo.mimeType,
        "content-length": String(bytes.length),
        "cache-control": "private, max-age=3000",
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

export async function DELETE(request: Request, context: Context) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  const actor = caller.membership;
  if (!mayHandlePhotos(actor.role, "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot remove photos of work", id);
  }

  const { id: visitId, photoId } = await context.params;
  if (!z.uuid().safeParse(visitId).success || !z.uuid().safeParse(photoId).success) {
    return apiError(404, "PHOTO_NOT_FOUND", "No photo with this ID", id);
  }

  const removed = await withTenant(actor.organizationId, async (tx) => {
    const [row] = await tx
      .select({ specialistId: visits.specialistId })
      .from(visitPhotos)
      .innerJoin(visits, eq(visits.id, visitPhotos.visitId))
      .where(and(eq(visitPhotos.id, photoId), eq(visitPhotos.visitId, visitId)))
      .limit(1);
    if (!row || !(await mayActOnSpecialist(tx, actor, row.specialistId))) return false;

    await queuePhotoDeletion(tx, actor.organizationId, photoId);
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "visit.photo_removed",
      entityType: "visit",
      entityId: visitId,
      after: { photo_id: photoId },
      requestId: id,
    });
    return true;
  });

  if (!removed) return apiError(404, "PHOTO_NOT_FOUND", "No photo with this ID", id);

  // After the commit: the row is gone either way, and the object follows now
  // or with the maintenance job.
  await flushStorageDeletions(actor.organizationId);
  return apiSuccess({ id: photoId, removed: true }, id);
}
