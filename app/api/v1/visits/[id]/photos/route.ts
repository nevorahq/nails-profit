import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { visitPhotos, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { avatarImageTypeOf } from "@/domain/avatar-image";
import {
  MAX_PHOTO_BYTES,
  MAX_PHOTO_DIMENSION,
  MAX_PHOTOS_PER_VISIT,
  photoUploadRefusal,
} from "@/domain/visit-photos";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { apiError, apiSuccess, rateLimited, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { getPhotoStorage, photoStoragePath, PhotoStorageError } from "@/lib/photo-storage";
import { checkRateLimit, rateLimitKey, VISIT_PHOTO_UPLOAD_RULE } from "@/lib/rate-limit";
import { mayHandlePhotos, photoUrl } from "@/lib/visit-photos";

/**
 * Photos of the work done at one visit, roadmap phase 8.
 *
 * Who: whoever may read (or change) the visit — a Master their own — except an
 * Analyst. A photo of somebody's hands is the client's, like their number and
 * the studio's note about them, so it is withheld under the same
 * `exclude_pii` rather than under a rule of its own that could drift from it.
 *
 * The bytes go to Storage inside the transaction that records the row, after
 * the limits are checked under a lock: a failed upload rolls the row back, and
 * two uploads racing for the fourth place on one visit, or for the last
 * kilobytes of the studio's quota, are taken one at a time.
 */
type Context = { params: Promise<{ id: string }> };

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

  const { id: visitId } = await context.params;
  if (!z.uuid().safeParse(visitId).success) return apiError(404, "VISIT_NOT_FOUND", "No visit with this ID", id);

  const photos = await withTenant(actor.organizationId, async (tx) => {
    const [visit] = await tx
      .select({ id: visits.id, specialistId: visits.specialistId })
      .from(visits)
      .where(eq(visits.id, visitId))
      .limit(1);
    if (!visit || !(await mayActOnSpecialist(tx, actor, visit.specialistId))) return null;
    return tx
      .select({
        id: visitPhotos.id,
        width: visitPhotos.width,
        height: visitPhotos.height,
        createdAt: visitPhotos.createdAt,
      })
      .from(visitPhotos)
      .where(eq(visitPhotos.visitId, visitId))
      .orderBy(asc(visitPhotos.createdAt));
  });

  if (!photos) return apiError(404, "VISIT_NOT_FOUND", "No visit with this ID", id);

  return apiSuccess(
    {
      enabled: getPhotoStorage() !== null,
      max_per_visit: MAX_PHOTOS_PER_VISIT,
      photos: photos.map((photo) => ({
        id: photo.id,
        url: photoUrl(visitId, photo.id),
        width: photo.width,
        height: photo.height,
        created_at: photo.createdAt,
      })),
    },
    id,
  );
}

const dimension = z.coerce.number().int().min(1).max(MAX_PHOTO_DIMENSION);

export async function POST(request: Request, context: Context) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  const actor = caller.membership;
  if (!mayHandlePhotos(actor.role, "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot add photos of work", id);
  }

  const storage = getPhotoStorage();
  if (!storage) return apiError(503, "PHOTOS_NOT_CONFIGURED", "Photo storage is not set up here", id);

  const { id: visitId } = await context.params;
  if (!z.uuid().safeParse(visitId).success) return apiError(404, "VISIT_NOT_FOUND", "No visit with this ID", id);

  // Before the body is read: refusing a caller who is over the limit should not
  // cost half a megabyte first.
  const limit = await checkRateLimit(rateLimitKey("visit.photo", request, actor.userId), VISIT_PHOTO_UPLOAD_RULE);
  if (!limit.allowed) {
    return rateLimited(id, limit.retryAfterSeconds, {
      bucket: "visit.photo",
      organizationId: actor.organizationId,
      userId: actor.userId,
    });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return apiError(422, "VALIDATION_ERROR", "A non-empty file is required", id, {
      fieldErrors: [{ field: "file", code: "required", message: "A non-empty file is required" }],
    });
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return apiError(413, "FILE_TOO_LARGE", "The photo exceeds the size limit", id, {
      details: { max_bytes: MAX_PHOTO_BYTES },
    });
  }
  const width = dimension.safeParse(form?.get("width"));
  const height = dimension.safeParse(form?.get("height"));
  if (!width.success || !height.success) {
    return apiError(422, "VALIDATION_ERROR", "Width and height are required", id, {
      fieldErrors: [{ field: "width", code: "invalid", message: `1–${MAX_PHOTO_DIMENSION} pixels` }],
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // What the bytes are, not what the browser called them.
  const mimeType = avatarImageTypeOf(bytes);
  if (!mimeType) {
    return apiError(422, "VALIDATION_ERROR", "The file is not a PNG, JPEG or WebP image", id, {
      fieldErrors: [{ field: "file", code: "invalid_type", message: "PNG, JPEG or WebP" }],
    });
  }

  try {
    const outcome = await withTenant(actor.organizationId, async (tx) => {
      const [visit] = await tx
        .select({ id: visits.id, specialistId: visits.specialistId })
        .from(visits)
        .where(eq(visits.id, visitId))
        .limit(1)
        .for("update");
      if (!visit || !(await mayActOnSpecialist(tx, actor, visit.specialistId))) {
        return { failure: "not_found" as const };
      }

      // The studio's quota is one number, so uploads to different visits wait
      // for each other here rather than both fitting into the same last megabyte.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`visit_photo:${actor.organizationId}`}))`);
      const [onVisit] = await tx
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(visitPhotos)
        .where(eq(visitPhotos.visitId, visitId));
      const [inStudio] = await tx
        .select({ bytes: sql<number>`cast(coalesce(sum(${visitPhotos.sizeBytes}), 0) as bigint)` })
        .from(visitPhotos)
        .where(eq(visitPhotos.organizationId, actor.organizationId));
      const refusal = photoUploadRefusal({
        photosOnVisit: onVisit.count,
        studioBytes: Number(inStudio.bytes),
        incomingBytes: bytes.length,
      });
      if (refusal) return { failure: refusal };

      const photoId = crypto.randomUUID();
      const storagePath = photoStoragePath(actor.organizationId, visitId, photoId, mimeType);
      await tx.insert(visitPhotos).values({
        id: photoId,
        organizationId: actor.organizationId,
        visitId,
        storagePath,
        mimeType,
        sizeBytes: bytes.length,
        width: width.data,
        height: height.data,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "visit.photo_added",
        entityType: "visit",
        entityId: visitId,
        after: { photo_id: photoId, size_bytes: bytes.length },
        requestId: id,
      });
      // Last, so that a refusal from Storage rolls the row back with it.
      await storage.put(storagePath, bytes, mimeType);
      return { photoId };
    });

    if ("failure" in outcome) {
      switch (outcome.failure) {
        case "not_found":
          return apiError(404, "VISIT_NOT_FOUND", "No visit with this ID", id);
        case "visit_full":
          return apiError(409, "VISIT_PHOTOS_FULL", "This visit already has the most photos it may", id, {
            details: { max_per_visit: MAX_PHOTOS_PER_VISIT },
          });
        case "quota_exceeded":
          return apiError(409, "PHOTO_QUOTA_EXCEEDED", "The studio's photo storage is full", id);
      }
    }

    return apiSuccess(
      { id: outcome.photoId, url: photoUrl(visitId, outcome.photoId), width: width.data, height: height.data },
      id,
      201,
    );
  } catch (error) {
    if (error instanceof PhotoStorageError) {
      return apiError(502, "PHOTO_STORAGE_FAILED", "The photo could not be stored", id);
    }
    throw error;
  }
}
