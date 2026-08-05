import { asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { materialPriceVersions, materials } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { baseUnitCostMinor, materialUnits, toMilliUnits } from "@/domain/units";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { recordCompletedServiceCostEvents } from "@/lib/pilot-events";

const createMaterialSchema = z.object({
  name: z.string().trim().min(1).max(200),
  base_unit: z.enum(materialUnits),
  sku: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(),
  supplier: z.string().trim().max(200).optional(),
  // Optional: a material can be catalogued before its price is known. The
  // costing engine already refuses to treat an unknown cost as free.
  package_price_minor: z.int().min(0).optional(),
  package_size: z.number().positive().optional(),
});

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  if (!can(caller.membership.role, "materials", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read materials", id);
  }

  const rows = await withTenant(caller.membership.organizationId, async (tx) => {
    const catalogue = await tx
      .select()
      .from(materials)
      .where(isNull(materials.archivedAt))
      .orderBy(asc(materials.name));

    return Promise.all(
      catalogue.map(async (material) => {
        const [price] = await tx
          .select({
            packagePriceMinor: materialPriceVersions.packagePriceMinor,
            packageSizeMilliUnits: materialPriceVersions.packageSizeMilliUnits,
            currency: materialPriceVersions.currency,
            validFrom: materialPriceVersions.validFrom,
          })
          .from(materialPriceVersions)
          .where(eq(materialPriceVersions.materialId, material.id))
          .orderBy(desc(materialPriceVersions.validFrom), desc(materialPriceVersions.createdAt))
          .limit(1);

        return {
          id: material.id,
          name: material.name,
          base_unit: material.baseUnit,
          sku: material.sku,
          category: material.category,
          supplier: material.supplier,
          // Null rather than zero when no price is on file — the whole point of
          // the incomplete-data warnings downstream.
          current_price: price
            ? {
                package_price_minor: price.packagePriceMinor,
                package_size_milli_units: price.packageSizeMilliUnits,
                currency: price.currency,
                base_unit_cost_minor: baseUnitCostMinor(
                  price.packagePriceMinor,
                  price.packageSizeMilliUnits,
                ),
                valid_from: price.validFrom,
              }
            : null,
        };
      }),
    );
  });

  return apiSuccess(rows, id);
}

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  // Catalogue write, so scope must be "all": a Master's materials permission
  // covers recording their own consumption, not editing the shared catalogue.
  if (!canManageCatalogue(actor.role, "materials")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage materials", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = createMaterialSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { package_price_minor: packagePrice, package_size: packageSize } = parsed.data;
  if ((packagePrice === undefined) !== (packageSize === undefined)) {
    return apiError(422, "INCOMPLETE_PRICE", "A price needs both a package price and a package size", id);
  }

  const material = await withTenant(actor.organizationId, async (tx) => {
    const [created] = await tx
      .insert(materials)
      .values({
        organizationId: actor.organizationId,
        name: parsed.data.name,
        baseUnit: parsed.data.base_unit,
        sku: parsed.data.sku ?? null,
        category: parsed.data.category ?? null,
        supplier: parsed.data.supplier ?? null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    if (packagePrice !== undefined && packageSize !== undefined) {
      await tx.insert(materialPriceVersions).values({
        organizationId: actor.organizationId,
        materialId: created.id,
        packagePriceMinor: packagePrice,
        packageSizeMilliUnits: toMilliUnits(packageSize),
        currency: "MDL",
        createdBy: actor.userId,
      });
    }

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "material.created",
      entityType: "material",
      entityId: created.id,
      after: { name: created.name, base_unit: created.baseUnit },
      requestId: id,
    });

    await recordCompletedServiceCostEvents(tx, actor);

    return created;
  });

  return apiSuccess({ id: material.id, name: material.name, base_unit: material.baseUnit }, id, 201);
}
