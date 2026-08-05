import { eq } from "drizzle-orm";
import { z } from "zod";

import { materialPriceVersions, materials } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { toMilliUnits } from "@/domain/units";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { recordCompletedServiceCostEvents } from "@/lib/pilot-events";

/**
 * Records a new purchase price, spec CST-004. Append-only by construction: this
 * inserts a version and never updates one, which is what keeps finished visits
 * from silently re-pricing when a supplier raises a price.
 */
const priceSchema = z.object({
  package_price_minor: z.int().min(0),
  package_size: z.number().positive(),
  currency: z.enum(["MDL", "EUR"]).default("MDL"),
  valid_from: z.iso.datetime().optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) {
    return apiError(401, "UNAUTHENTICATED", "Authentication is required", requestIdentifier);
  }
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", requestIdentifier);
  }

  const actor = caller.membership;
  // A purchase price is catalogue data shared by everyone; see canManageCatalogue.
  if (!canManageCatalogue(actor.role, "materials")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage materials", requestIdentifier);
  }

  const body = await request.json().catch(() => null);
  const parsed = priceSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", requestIdentifier, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;

  const created = await withTenant(actor.organizationId, async (tx) => {
    // RLS makes a cross-tenant id simply invisible, so this answers 404 rather
    // than confirming the material exists elsewhere (section 6.2).
    const [material] = await tx.select().from(materials).where(eq(materials.id, id)).limit(1);
    if (!material) return null;

    const [version] = await tx
      .insert(materialPriceVersions)
      .values({
        organizationId: actor.organizationId,
        materialId: material.id,
        packagePriceMinor: parsed.data.package_price_minor,
        packageSizeMilliUnits: toMilliUnits(parsed.data.package_size),
        currency: parsed.data.currency,
        validFrom: parsed.data.valid_from ? new Date(parsed.data.valid_from) : new Date(),
        createdBy: actor.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "material.price_recorded",
      entityType: "material_price_version",
      entityId: version.id,
      after: {
        material_id: material.id,
        package_price_minor: version.packagePriceMinor,
        package_size_milli_units: version.packageSizeMilliUnits,
      },
      requestId: requestIdentifier,
    });

    await recordCompletedServiceCostEvents(tx, actor);

    return version;
  });

  if (!created) {
    return apiError(404, "MATERIAL_NOT_FOUND", "No material with this ID", requestIdentifier);
  }

  return apiSuccess(
    {
      id: created.id,
      package_price_minor: created.packagePriceMinor,
      package_size_milli_units: created.packageSizeMilliUnits,
      currency: created.currency,
      valid_from: created.validFrom,
    },
    requestIdentifier,
    201,
  );
}
