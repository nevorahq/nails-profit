import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { galleryPhotos, visitPhotos, visits } from "@/db/schema";
import { withTenant, type TenantTransaction } from "@/db/tenant";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnSpecialist, type CalendarActor } from "@/lib/booking-access";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { mayHandlePhotos } from "@/lib/visit-photos";

/**
 * Showing one photo of work on the studio's public booking page, and taking it
 * down again.
 *
 * Who: whoever may add photos to the visit — a Master only their own. The
 * photo is the client's hands, so publishing needs the studio to say the
 * client agreed (`client_consent: true`); the row's `created_at` and
 * `created_by` are the record of when and by whom, and the audit event repeats
 * it. Taking a photo down needs no such statement.
 */
type Context = { params: Promise<{ id: string; photoId: string }> };

async function authorize(request: Request, context: Context) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return { id, refused: apiError(401, "UNAUTHENTICATED", "Authentication is required", id) };
  if (!caller.membership) {
    return { id, refused: apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id) };
  }
  const actor = caller.membership;
  if (!mayHandlePhotos(actor.role, "write")) {
    return { id, refused: apiError(403, "FORBIDDEN", "This role cannot publish photos of work", id) };
  }
  const { id: visitId, photoId } = await context.params;
  if (!z.uuid().safeParse(visitId).success || !z.uuid().safeParse(photoId).success) {
    return { id, refused: apiError(404, "PHOTO_NOT_FOUND", "No photo with this ID", id) };
  }
  return { id, actor, visitId, photoId };
}

async function mayPublish(
  tx: TenantTransaction,
  actor: CalendarActor,
  visitId: string,
  photoId: string,
) {
  const [row] = await tx
    .select({ specialistId: visits.specialistId })
    .from(visitPhotos)
    .innerJoin(visits, eq(visits.id, visitPhotos.visitId))
    .where(and(eq(visitPhotos.id, photoId), eq(visitPhotos.visitId, visitId)))
    .limit(1);
  return !!row && (await mayActOnSpecialist(tx, actor, row.specialistId));
}

const consent = z.object({ client_consent: z.literal(true) });

export async function POST(request: Request, context: Context) {
  const checked = await authorize(request, context);
  if (checked.refused) return checked.refused;
  const { id, actor, visitId, photoId } = checked;

  const parsed = consent.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The client's consent has to be confirmed", id, {
      fieldErrors: [{ field: "client_consent", code: "required", message: "Confirm the client agreed" }],
    });
  }

  const found = await withTenant(actor.organizationId, async (tx) => {
    if (!(await mayPublish(tx, actor, visitId, photoId))) return false;
    // Publishing twice is the same publication, not a second tile.
    const inserted = await tx
      .insert(galleryPhotos)
      .values({
        organizationId: actor.organizationId,
        visitPhotoId: photoId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .onConflictDoNothing()
      .returning({ id: galleryPhotos.id });
    if (inserted.length > 0) {
      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "visit.photo_published",
        entityType: "visit",
        entityId: visitId,
        after: { photo_id: photoId, client_consent: true },
        requestId: id,
      });
    }
    return true;
  });

  if (!found) return apiError(404, "PHOTO_NOT_FOUND", "No photo with this ID", id);
  return apiSuccess({ id: photoId, published: true }, id);
}

export async function DELETE(request: Request, context: Context) {
  const checked = await authorize(request, context);
  if (checked.refused) return checked.refused;
  const { id, actor, visitId, photoId } = checked;

  const found = await withTenant(actor.organizationId, async (tx) => {
    if (!(await mayPublish(tx, actor, visitId, photoId))) return false;
    const removed = await tx
      .delete(galleryPhotos)
      .where(eq(galleryPhotos.visitPhotoId, photoId))
      .returning({ id: galleryPhotos.id });
    if (removed.length > 0) {
      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "visit.photo_unpublished",
        entityType: "visit",
        entityId: visitId,
        after: { photo_id: photoId },
        requestId: id,
      });
    }
    return true;
  });

  if (!found) return apiError(404, "PHOTO_NOT_FOUND", "No photo with this ID", id);
  return apiSuccess({ id: photoId, published: false }, id);
}
