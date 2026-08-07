import { eq } from "drizzle-orm";
import { z } from "zod";

import { materials } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { materialUnits } from "@/domain/units";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

const patchMaterialSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  base_unit: z.enum(materialUnits).optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const reqId = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", reqId);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", reqId);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "materials")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage materials", reqId);
  }

  const body = await request.json().catch(() => null);
  const parsed = patchMaterialSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", reqId, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;

  const updated = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(materials)
      .where(eq(materials.id, id))
      .limit(1);
    if (!existing || existing.archivedAt) return null;

    const [material] = await tx
      .update(materials)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.base_unit !== undefined ? { baseUnit: parsed.data.base_unit } : {}),
        updatedBy: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(materials.id, id))
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "material.updated",
      entityType: "material",
      entityId: material.id,
      before: { name: existing.name, base_unit: existing.baseUnit },
      after: { name: material.name, base_unit: material.baseUnit },
      requestId: reqId,
    });

    return material;
  });

  if (!updated) {
    return apiError(404, "MATERIAL_NOT_FOUND", "No material with this ID", reqId);
  }

  return apiSuccess({ id: updated.id, name: updated.name, base_unit: updated.baseUnit }, reqId);
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const reqId = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", reqId);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", reqId);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "materials")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage materials", reqId);
  }

  const { id } = await context.params;

  const archived = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(materials)
      .where(eq(materials.id, id))
      .limit(1);
    if (!existing || existing.archivedAt) return null;

    const [material] = await tx
      .update(materials)
      .set({ archivedAt: new Date(), updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(materials.id, id))
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "material.archived",
      entityType: "material",
      entityId: material.id,
      before: { name: existing.name },
      after: { archived: true },
      requestId: reqId,
    });

    return material;
  });

  if (!archived) {
    return apiError(404, "MATERIAL_NOT_FOUND", "No material with this ID", reqId);
  }

  return apiSuccess({ id: archived.id }, reqId);
}
