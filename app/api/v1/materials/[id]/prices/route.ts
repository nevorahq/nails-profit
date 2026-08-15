import { eq } from "drizzle-orm";
import { z } from "zod";

import { materialPriceVersions, materials } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import {
  materialCostingModes,
  normalizeMaterialPriceProfile,
} from "@/domain/material-pricing";
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
  costing_mode: z.enum(materialCostingModes).default("quantity"),
  package_price_minor: z.int().min(0).optional(),
  package_size: z.number().positive().optional(),
  services_per_package: z.number().positive().optional(),
  fixed_cost_minor: z.int().min(0).optional(),
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
  const profile =
    parsed.data.costing_mode === "quantity" &&
    parsed.data.package_price_minor !== undefined &&
    parsed.data.package_size !== undefined
      ? normalizeMaterialPriceProfile({
          mode: "quantity",
          packagePriceMinor: parsed.data.package_price_minor,
          packageSize: parsed.data.package_size,
        })
      : parsed.data.costing_mode === "services_per_package" &&
          parsed.data.package_price_minor !== undefined &&
          parsed.data.services_per_package !== undefined
        ? normalizeMaterialPriceProfile({
            mode: "services_per_package",
            packagePriceMinor: parsed.data.package_price_minor,
            servicesPerPackage: parsed.data.services_per_package,
          })
        : parsed.data.costing_mode === "fixed_per_service" &&
            parsed.data.fixed_cost_minor !== undefined
          ? normalizeMaterialPriceProfile({
              mode: "fixed_per_service",
              fixedCostMinor: parsed.data.fixed_cost_minor,
            })
          : null;
  if (!profile) {
    return apiError(
      422,
      "INCOMPLETE_PRICE",
      "The selected costing mode needs all of its price fields",
      requestIdentifier,
    );
  }

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
        packagePriceMinor: profile.packagePriceMinor,
        packageSizeMilliUnits: profile.packageSizeMilliUnits,
        costingMode: profile.mode,
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
        costing_mode: version.costingMode,
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
      costing_mode: created.costingMode,
      currency: created.currency,
      valid_from: created.validFrom,
    },
    requestIdentifier,
    201,
  );
}
