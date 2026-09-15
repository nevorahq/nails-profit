import { eq, sql } from "drizzle-orm";

import { organizationLogos } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { avatarImageTypeOf } from "@/domain/avatar-image";
import { can } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, rateLimited, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { AVATAR_UPLOAD_RULE, callerKey, checkRateLimit } from "@/lib/rate-limit";

/**
 * The studio's own mark: the one endpoint that reads the bytes and the one that
 * writes them.
 *
 * The topbar draws a flower beside the studio's name — `BrandMark`, the
 * product's mark, the same one in every salon here. A studio that has uploaded
 * a logo gets its own in that place instead, and a studio that removes one gets
 * the flower back. That is the whole feature: there is no state where the mark
 * is missing.
 *
 * Reading is open to everyone in the organization and writing is not. The mark
 * is on every screen the moment it exists, so hiding the bytes from a master
 * who can see it drawn would protect nothing; setting one is editing the
 * studio, which is what `organization_settings` already decides for its name,
 * its language and its currency — owner only.
 *
 * Shaped after `/api/v1/specialists/[id]/avatar`, deliberately and closely: the
 * two-step read that answers a repeat request without the bytes, the type taken
 * from the signature rather than from the upload's own header, the version
 * moved by the database. Where the comments there explain a decision, it is the
 * same decision here.
 */

/** Half a megabyte, the same ceiling the column's check constraint states. */
export const MAX_LOGO_BYTES = 512 * 1024;

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;

  /*
   * Read in two steps, and the first one leaves the bytes behind: the topbar
   * asks for this mark on every page of every session, so the common case is a
   * request for a picture the browser already holds.
   */
  const meta = await withTenant(actor.organizationId, async (tx) => {
    const [row] = await tx
      .select({
        mimeType: organizationLogos.mimeType,
        version: organizationLogos.version,
        updatedAt: organizationLogos.updatedAt,
      })
      .from(organizationLogos)
      .where(eq(organizationLogos.organizationId, actor.organizationId))
      .limit(1);
    return row ?? null;
  });

  if (!meta) return apiError(404, "NOT_FOUND", "This organization has no logo", id);

  const etag = `"${meta.version}-${meta.updatedAt.getTime()}"`;
  const headers = {
    etag,
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
    "x-request-id": id,
  };

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const bytes = await withTenant(actor.organizationId, async (tx) => {
    const [row] = await tx
      .select({ bytes: organizationLogos.bytes })
      .from(organizationLogos)
      .where(eq(organizationLogos.organizationId, actor.organizationId))
      .limit(1);
    return row?.bytes ?? null;
  });

  // Removed between the two reads: rare, and a 404 is the truthful answer.
  if (!bytes) return apiError(404, "NOT_FOUND", "This organization has no logo", id);

  return new Response(new Uint8Array(bytes), {
    headers: { ...headers, "content-type": meta.mimeType, "content-length": String(bytes.length) },
  });
}

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "organization_settings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot change the organization", id);
  }

  // Before the body is read: refusing a caller who is already over the limit
  // should not cost half a megabyte first.
  const limit = await checkRateLimit(callerKey(request, actor.userId), AVATAR_UPLOAD_RULE);
  if (!limit.allowed) {
    return rateLimited(id, limit.retryAfterSeconds, {
      bucket: "organization.logo",
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
  if (file.size > MAX_LOGO_BYTES) {
    return apiError(413, "FILE_TOO_LARGE", "The logo exceeds the size limit", id, {
      details: { max_bytes: MAX_LOGO_BYTES },
    });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  /*
   * The type comes from the bytes, never from the part's own header — and an
   * SVG is refused rather than converted, which matters more for a logo than
   * for a face: a logo is exactly the kind of file a designer hands over as
   * markup, and markup drawn in the topbar of every signed-in page is markup
   * that runs there.
   */
  const mimeType = avatarImageTypeOf(bytes);
  if (!mimeType) {
    return apiError(422, "VALIDATION_ERROR", "The file is not a PNG, JPEG or WebP image", id, {
      fieldErrors: [{ field: "file", code: "invalid", message: "The file is not a PNG, JPEG or WebP image" }],
    });
  }

  const stored = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx
      .select({ version: organizationLogos.version, mimeType: organizationLogos.mimeType })
      .from(organizationLogos)
      .where(eq(organizationLogos.organizationId, actor.organizationId))
      .limit(1);

    const [row] = await tx
      .insert(organizationLogos)
      .values({
        organizationId: actor.organizationId,
        mimeType,
        bytes,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .onConflictDoUpdate({
        target: organizationLogos.organizationId,
        set: {
          mimeType,
          bytes,
          // Incremented by the database rather than from the row read above:
          // two owners uploading at the same instant would otherwise compute
          // the same next version, and the second mark would arrive wearing the
          // first one's ETag.
          version: sql`${organizationLogos.version} + 1`,
          updatedBy: actor.userId,
          updatedAt: new Date(),
        },
      })
      .returning({ version: organizationLogos.version, mimeType: organizationLogos.mimeType });

    /*
     * The event records the shape of the picture and never the picture, for the
     * reason the avatar route gives: an audit log is read as text and kept
     * longer than the row it describes.
     */
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: existing ? "organization.logo_replaced" : "organization.logo_set",
      entityType: "organization",
      entityId: actor.organizationId,
      before: existing ? { mime_type: existing.mimeType, version: existing.version } : null,
      after: { mime_type: row.mimeType, version: row.version, byte_size: bytes.length },
      requestId: id,
    });

    return {
      organization_id: actor.organizationId,
      mime_type: row.mimeType,
      byte_size: bytes.length,
      version: row.version,
    };
  });

  return apiSuccess(stored, id, 201);
}

export async function DELETE(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "organization_settings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot change the organization", id);
  }

  const removed = await withTenant(actor.organizationId, async (tx) => {
    const [row] = await tx
      .delete(organizationLogos)
      .where(eq(organizationLogos.organizationId, actor.organizationId))
      .returning({ mimeType: organizationLogos.mimeType, version: organizationLogos.version });
    if (!row) return null;

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "organization.logo_removed",
      entityType: "organization",
      entityId: actor.organizationId,
      before: { mime_type: row.mimeType, version: row.version },
      after: null,
      requestId: id,
    });

    return { removed: actor.organizationId } as const;
  });

  if (!removed) return apiError(404, "NOT_FOUND", "This organization has no logo", id);

  return apiSuccess(removed, id);
}
