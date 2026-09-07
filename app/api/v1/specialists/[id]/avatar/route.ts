import { eq, sql } from "drizzle-orm";

import { specialistAvatars, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { avatarImageTypeOf } from "@/domain/avatar-image";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, rateLimited, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { AVATAR_UPLOAD_RULE, callerKey, checkRateLimit } from "@/lib/rate-limit";

/**
 * A master's photo: the one endpoint that reads the bytes and the one that
 * writes them.
 *
 * The calendar and the visits list have drawn a circle with a letter in it
 * since they were written, because the picture they looked for lived on the
 * account (`user.image`) and nothing has ever put one there. This is where it
 * comes from instead — the card, which exists for every master a studio
 * records, including the ones who never sign in.
 *
 * Reading is open to the whole organization and writing is not. A face is
 * already on every screen that lists people, so hiding the bytes from a role
 * that can see the face would protect nothing; setting one is editing the card,
 * which is what `canManageCatalogue` decides for every other field on it.
 *
 * A master cannot yet change their own photo. That is a real gap and a separate
 * decision: it needs a screen a master can reach — there is no profile page in
 * the application at all — and a scope rule that lets them edit exactly one
 * field of exactly one card. Until both exist, the owner sets the picture the
 * way they set the name.
 */

/**
 * Half a megabyte, the same ceiling the column's check constraint states.
 *
 * The browser sends a re-encoded square that lands an order of magnitude under
 * this; the limit is here for what arrives when it does not, and it is checked
 * before the bytes are read rather than after.
 */
export const MAX_AVATAR_BYTES = 512 * 1024;

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  const { id: specialistId } = await context.params;

  /*
   * The row is read in two steps, and the first one leaves the bytes behind.
   *
   * A day view draws one of these per column and a visits list one per group,
   * so most requests for a photo are requests for a photo the browser already
   * holds. Answering those from the version alone means the common case never
   * moves half a megabyte out of the database.
   */
  const meta = await withTenant(actor.organizationId, async (tx) => {
    const [row] = await tx
      .select({
        mimeType: specialistAvatars.mimeType,
        version: specialistAvatars.version,
        updatedAt: specialistAvatars.updatedAt,
      })
      .from(specialistAvatars)
      .where(eq(specialistAvatars.specialistId, specialistId))
      .limit(1);
    return row ?? null;
  });

  if (!meta) return apiError(404, "NOT_FOUND", "This specialist has no photo", id);

  const etag = `"${meta.version}-${meta.updatedAt.getTime()}"`;
  const headers = {
    etag,
    /*
     * Private, because the photo is behind a session and a shared cache must
     * not keep it. Revalidated every time, because the alternative is a stale
     * face after an owner replaces one — and a revalidation that hits the
     * `if-none-match` branch above costs a row without its bytes.
     */
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
    "x-request-id": id,
  };

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const bytes = await withTenant(actor.organizationId, async (tx) => {
    const [row] = await tx
      .select({ bytes: specialistAvatars.bytes })
      .from(specialistAvatars)
      .where(eq(specialistAvatars.specialistId, specialistId))
      .limit(1);
    return row?.bytes ?? null;
  });

  // Gone between the two reads: rare, and a 404 is the truthful answer.
  if (!bytes) return apiError(404, "NOT_FOUND", "This specialist has no photo", id);

  return new Response(new Uint8Array(bytes), {
    headers: { ...headers, "content-type": meta.mimeType, "content-length": String(bytes.length) },
  });
}

export async function POST(request: Request, context: Context) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "commissions")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage specialists", id);
  }

  // Before the body is read, like the import upload: refusing a caller who is
  // already over the limit should not cost half a megabyte first.
  const limit = await checkRateLimit(callerKey(request, actor.userId), AVATAR_UPLOAD_RULE);
  if (!limit.allowed) {
    return rateLimited(id, limit.retryAfterSeconds, {
      bucket: "specialist.avatar",
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
  if (file.size > MAX_AVATAR_BYTES) {
    return apiError(413, "FILE_TOO_LARGE", "The photo exceeds the size limit", id, {
      details: { max_bytes: MAX_AVATAR_BYTES },
    });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  /*
   * The type comes from the bytes, never from the part's own header: the
   * browser writes that header, and so does anything pretending to be one. It
   * is also what the database is about to be told, so a value derived from the
   * content is the only one that cannot make the row lie.
   */
  const mimeType = avatarImageTypeOf(bytes);
  if (!mimeType) {
    return apiError(422, "VALIDATION_ERROR", "The file is not a PNG, JPEG or WebP image", id, {
      fieldErrors: [{ field: "file", code: "invalid", message: "The file is not a PNG, JPEG or WebP image" }],
    });
  }

  const { id: specialistId } = await context.params;

  const stored = await withTenant(actor.organizationId, async (tx) => {
    const [specialist] = await tx
      .select({ id: specialists.id, name: specialists.name })
      .from(specialists)
      .where(eq(specialists.id, specialistId))
      .limit(1);
    if (!specialist) return null;

    const [existing] = await tx
      .select({ version: specialistAvatars.version, mimeType: specialistAvatars.mimeType })
      .from(specialistAvatars)
      .where(eq(specialistAvatars.specialistId, specialistId))
      .limit(1);

    /*
     * One row per card, replaced rather than appended to: a photo has no
     * history worth keeping and every old one would be half a megabyte of it.
     * The version is what the browser caches against, so it moves on every
     * write even when the bytes happen to be identical.
     */
    const [row] = await tx
      .insert(specialistAvatars)
      .values({
        specialistId,
        organizationId: actor.organizationId,
        mimeType,
        bytes,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .onConflictDoUpdate({
        target: specialistAvatars.specialistId,
        set: {
          mimeType,
          bytes,
          // Incremented by the database rather than from the row read above:
          // two managers uploading at the same instant would otherwise compute
          // the same next version, and the second photo would arrive wearing
          // the first one's ETag.
          version: sql`${specialistAvatars.version} + 1`,
          updatedBy: actor.userId,
          updatedAt: new Date(),
        },
      })
      .returning({ version: specialistAvatars.version, mimeType: specialistAvatars.mimeType });

    /*
     * The event records the shape of the photo and never the photo. An audit
     * log is read as text and kept longer than the row it describes; putting a
     * face in it would make it the second place a studio has to erase.
     */
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: existing ? "specialist.avatar_replaced" : "specialist.avatar_set",
      entityType: "specialist",
      entityId: specialistId,
      before: existing ? { mime_type: existing.mimeType, version: existing.version } : null,
      after: { mime_type: row.mimeType, version: row.version, byte_size: bytes.length },
      requestId: id,
    });

    return { specialist_id: specialistId, mime_type: row.mimeType, byte_size: bytes.length, version: row.version };
  });

  if (!stored) return apiError(404, "NOT_FOUND", "Specialist not found", id);

  return apiSuccess(stored, id, 201);
}

export async function DELETE(request: Request, context: Context) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "commissions")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage specialists", id);
  }

  const { id: specialistId } = await context.params;

  const removed = await withTenant(actor.organizationId, async (tx) => {
    const [row] = await tx
      .delete(specialistAvatars)
      .where(eq(specialistAvatars.specialistId, specialistId))
      .returning({ mimeType: specialistAvatars.mimeType, version: specialistAvatars.version });
    if (!row) return null;

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "specialist.avatar_removed",
      entityType: "specialist",
      entityId: specialistId,
      before: { mime_type: row.mimeType, version: row.version },
      after: null,
      requestId: id,
    });

    return { removed: specialistId } as const;
  });

  if (!removed) return apiError(404, "NOT_FOUND", "This specialist has no photo", id);

  return apiSuccess(removed, id);
}
