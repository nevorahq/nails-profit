import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { materialPriceVersions, materialPurchases, materials } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { toMilliUnits } from "@/domain/units";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { recordCompletedServiceCostEvents } from "@/lib/pilot-events";

/**
 * Recording what was actually bought, spec CST-011 and section 33 of the
 * materials brief.
 *
 * A purchase does two things at once, and only one of them is new. It adds to
 * the estimated balance, which is what the table is for. And unless it is
 * backdated, it states the price now being paid — so it writes a
 * `material_price_version` exactly as the price endpoint does, and points at
 * it. There is no second cost basis: a future visit is still costed on the
 * newest price version, and a visit already closed still holds the pair it
 * snapshotted.
 *
 * Deliberately *not* a weighted average. The brief offers one as a default, and
 * the analysis said no: this codebase's cost basis is an append-only history
 * where the newest entry is in force and the owner can see every figure they
 * typed. Silently costing services at a number nobody entered — one that moves
 * every time a crate is bought — would put a second answer to "what does this
 * cost" into a product whose whole argument is that there is one. The average
 * is computed and shown on the card instead, where it says whether the price on
 * file still resembles reality.
 */

const purchaseSchema = z.object({
  package_quantity: z.int().min(1).max(10_000),
  /** In base units, converted to thousandths here like every other quantity. */
  package_size: z.number().positive().max(1_000_000),
  unit_package_cost_minor: z.int().min(0),
  currency: z.enum(["MDL", "EUR"]).default("MDL"),
  purchased_at: z.iso.datetime().optional(),
  supplier: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const reqId = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", reqId);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", reqId);
  }
  if (!can(caller.membership.role, "materials", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read materials", reqId);
  }

  const { id } = await context.params;

  const rows = await withTenant(caller.membership.organizationId, async (tx) => {
    // RLS makes another tenant's id invisible, so this is a 404 rather than a
    // confirmation that the material exists somewhere else (section 6.2).
    const [material] = await tx.select({ id: materials.id }).from(materials).where(eq(materials.id, id)).limit(1);
    if (!material) return null;

    return tx
      .select()
      .from(materialPurchases)
      .where(eq(materialPurchases.materialId, id))
      .orderBy(desc(materialPurchases.purchasedAt));
  });

  if (rows === null) return apiError(404, "MATERIAL_NOT_FOUND", "No material with this ID", reqId);

  return apiSuccess(
    rows.map((row) => ({
      id: row.id,
      package_quantity: row.packageQuantity,
      package_size_milli_units: row.packageSizeMilliUnits,
      unit_package_cost_minor: row.unitPackageCostMinor,
      total_cost_minor: row.totalCostMinor,
      currency: row.currency,
      purchased_at: row.purchasedAt,
      supplier: row.supplier,
      note: row.note,
    })),
    reqId,
  );
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const reqId = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", reqId);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", reqId);
  }

  const actor = caller.membership;
  // A purchase price is catalogue data everyone else's costs are computed from;
  // a Master's `materials` write covers their own consumption, not this.
  if (!canManageCatalogue(actor.role, "materials")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage materials", reqId);
  }

  const body = await request.json().catch(() => null);
  const parsed = purchaseSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", reqId, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;
  const purchasedAt = parsed.data.purchased_at ? new Date(parsed.data.purchased_at) : new Date();
  const packageSizeMilliUnits = toMilliUnits(parsed.data.package_size);

  const created = await withTenant(actor.organizationId, async (tx) => {
    const [material] = await tx.select().from(materials).where(eq(materials.id, id)).limit(1);
    if (!material || material.archivedAt) return null;

    /*
     * Whether this purchase also restates the cost basis.
     *
     * A receipt entered a week late must not overwrite a price recorded since:
     * the newest version is what future visits are costed on, and a backdated
     * row winning would re-price the catalogue to what was true before the last
     * change. So the price version is written only when nothing newer is on
     * file; the purchase itself is recorded either way.
     */
    const [newest] = await tx
      .select({ validFrom: materialPriceVersions.validFrom })
      .from(materialPriceVersions)
      .where(eq(materialPriceVersions.materialId, material.id))
      .orderBy(desc(materialPriceVersions.validFrom), desc(materialPriceVersions.createdAt))
      .limit(1);

    const restatesCostBasis = !newest || newest.validFrom.getTime() <= purchasedAt.getTime();

    const priceVersion = restatesCostBasis
      ? (
          await tx
            .insert(materialPriceVersions)
            .values({
              organizationId: actor.organizationId,
              materialId: material.id,
              packagePriceMinor: parsed.data.unit_package_cost_minor,
              packageSizeMilliUnits,
              costingMode: "quantity",
              currency: parsed.data.currency,
              validFrom: purchasedAt,
              createdBy: actor.userId,
            })
            .returning()
        )[0]
      : null;

    const [purchase] = await tx
      .insert(materialPurchases)
      .values({
        organizationId: actor.organizationId,
        materialId: material.id,
        packageQuantity: parsed.data.package_quantity,
        packageSizeMilliUnits,
        unitPackageCostMinor: parsed.data.unit_package_cost_minor,
        currency: parsed.data.currency,
        purchasedAt,
        supplier: parsed.data.supplier ?? null,
        note: parsed.data.note ?? null,
        priceVersionId: priceVersion?.id ?? null,
        createdBy: actor.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "material.purchase_recorded",
      entityType: "material_purchase",
      entityId: purchase.id,
      after: {
        material_id: material.id,
        package_quantity: purchase.packageQuantity,
        unit_package_cost_minor: purchase.unitPackageCostMinor,
        restated_cost_basis: priceVersion !== null,
      },
      requestId: reqId,
    });

    if (priceVersion) await recordCompletedServiceCostEvents(tx, actor);

    return { purchase, priceVersion };
  });

  if (!created) return apiError(404, "MATERIAL_NOT_FOUND", "No material with this ID", reqId);

  return apiSuccess(
    {
      id: created.purchase.id,
      package_quantity: created.purchase.packageQuantity,
      package_size_milli_units: created.purchase.packageSizeMilliUnits,
      unit_package_cost_minor: created.purchase.unitPackageCostMinor,
      total_cost_minor: created.purchase.totalCostMinor,
      currency: created.purchase.currency,
      purchased_at: created.purchase.purchasedAt,
      /** False for a backdated receipt: what future visits cost stays as it was. */
      restated_cost_basis: created.priceVersion !== null,
    },
    reqId,
    201,
  );
}
