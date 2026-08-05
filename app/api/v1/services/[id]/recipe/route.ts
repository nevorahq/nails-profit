import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { recipeItems, recipes, services } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { toMilliUnits } from "@/domain/units";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Replaces a service's recipe, spec CST-005.
 *
 * Writes a new recipe version rather than editing items in place. CST-004 and
 * the roadmap both require that changing a recipe leave finished visits alone,
 * and the only way to keep that promise is for the old version to still exist.
 */
const recipeSchema = z.object({
  items: z
    .array(
      z.object({
        material_id: z.uuid(),
        quantity: z.number().positive(),
      }),
    )
    .max(100),
});

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) {
    return apiError(401, "UNAUTHENTICATED", "Authentication is required", requestIdentifier);
  }
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", requestIdentifier);
  }

  const actor = caller.membership;
  // A recipe is the norm every master is measured against, not one visit.
  if (!canManageCatalogue(actor.role, "materials")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage recipes", requestIdentifier);
  }

  const body = await request.json().catch(() => null);
  const parsed = recipeSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", requestIdentifier, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const uniqueMaterials = new Set(parsed.data.items.map((item) => item.material_id));
  if (uniqueMaterials.size !== parsed.data.items.length) {
    return apiError(422, "DUPLICATE_MATERIAL", "A material may appear only once in a recipe", requestIdentifier);
  }

  const { id } = await context.params;

  const result = await withTenant(actor.organizationId, async (tx) => {
    const [service] = await tx.select().from(services).where(eq(services.id, id)).limit(1);
    if (!service) return null;

    const [previous] = await tx
      .select({ recipeVersion: recipes.recipeVersion })
      .from(recipes)
      .where(eq(recipes.serviceId, service.id))
      .orderBy(desc(recipes.recipeVersion))
      .limit(1);

    const nextVersion = (previous?.recipeVersion ?? 0) + 1;

    const [recipe] = await tx
      .insert(recipes)
      .values({
        organizationId: actor.organizationId,
        serviceId: service.id,
        recipeVersion: nextVersion,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    if (parsed.data.items.length > 0) {
      await tx.insert(recipeItems).values(
        parsed.data.items.map((item) => ({
          organizationId: actor.organizationId,
          recipeId: recipe.id,
          materialId: item.material_id,
          normativeQuantityMilliUnits: toMilliUnits(item.quantity),
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })),
      );
    }

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "recipe.version_created",
      entityType: "recipe",
      entityId: recipe.id,
      after: { service_id: service.id, recipe_version: nextVersion, items: parsed.data.items.length },
      requestId: requestIdentifier,
    });

    return { recipeId: recipe.id, version: nextVersion, items: parsed.data.items.length };
  });

  if (!result) {
    return apiError(404, "SERVICE_NOT_FOUND", "No service with this ID", requestIdentifier);
  }

  return apiSuccess(
    { recipe_id: result.recipeId, recipe_version: result.version, items: result.items },
    requestIdentifier,
    201,
  );
}
