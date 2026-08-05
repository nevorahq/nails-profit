import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { addOns, recipeItems, recipes } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { toMilliUnits } from "@/domain/units";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * An add-on's own recipe (SRV-003, CST-005). Versioned exactly like a service
 * recipe: a new version is written, the old one stays, so finished visits keep
 * the materials they were actually costed with.
 */
const recipeSchema = z.object({
  items: z.array(z.object({ material_id: z.uuid(), quantity: z.number().positive() })).max(100),
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

  if (new Set(parsed.data.items.map((item) => item.material_id)).size !== parsed.data.items.length) {
    return apiError(422, "DUPLICATE_MATERIAL", "A material may appear only once in a recipe", requestIdentifier);
  }

  const { id } = await context.params;

  const result = await withTenant(actor.organizationId, async (tx) => {
    const [addOn] = await tx.select().from(addOns).where(eq(addOns.id, id)).limit(1);
    if (!addOn) return null;

    const [previous] = await tx
      .select({ recipeVersion: recipes.recipeVersion })
      .from(recipes)
      .where(eq(recipes.addOnId, addOn.id))
      .orderBy(desc(recipes.recipeVersion))
      .limit(1);

    const nextVersion = (previous?.recipeVersion ?? 0) + 1;

    const [recipe] = await tx
      .insert(recipes)
      .values({
        organizationId: actor.organizationId,
        addOnId: addOn.id,
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
      after: { add_on_id: addOn.id, recipe_version: nextVersion, items: parsed.data.items.length },
      requestId: requestIdentifier,
    });

    return { recipeId: recipe.id, version: nextVersion };
  });

  if (!result) {
    return apiError(404, "ADD_ON_NOT_FOUND", "No add-on with this ID", requestIdentifier);
  }

  return apiSuccess({ recipe_id: result.recipeId, recipe_version: result.version }, requestIdentifier, 201);
}
