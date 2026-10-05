import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { addOns } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Changing an add-on after it was made: its materials.
 *
 * The one field, because it is the one an add-on could not have been given
 * when it was created — every add-on in the catalogue predates it. Its name,
 * price and time are still set at creation only; widening this route to them
 * is a change of its own, with its own audit question.
 *
 * The same permission as the service it hangs off: a catalogue manager's, and
 * not a Master's, since the figure costs every master's visit with it.
 */
const patchAddOnSchema = z.object({
  materials_minor: z.int().min(0).max(100_000_000).nullable(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "services")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage add-ons", id);
  }

  const parsed = patchAddOnSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id: addOnId } = await context.params;
  if (!z.uuid().safeParse(addOnId).success) {
    return apiError(404, "ADD_ON_NOT_FOUND", "No add-on with this ID", id);
  }

  const updated = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx.select().from(addOns).where(eq(addOns.id, addOnId)).limit(1);
    if (!existing) return null;

    const [addOn] = await tx
      .update(addOns)
      .set({
        materialsMinor: parsed.data.materials_minor,
        updatedBy: actor.userId,
        updatedAt: new Date(),
        version: sql`${addOns.version} + 1`,
      })
      .where(eq(addOns.id, addOnId))
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "add_on.updated",
      entityType: "add_on",
      entityId: addOn.id,
      before: { materials_minor: existing.materialsMinor },
      after: { materials_minor: addOn.materialsMinor },
      requestId: id,
    });

    return addOn;
  });

  if (!updated) return apiError(404, "ADD_ON_NOT_FOUND", "No add-on with this ID", id);

  return apiSuccess({ id: updated.id, materials_minor: updated.materialsMinor }, id);
}
