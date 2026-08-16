import { eq } from "drizzle-orm";
import { z } from "zod";

import { materialStockChecks, materials } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { materialStockCheckBases } from "@/domain/material-stock";
import { toMilliUnits } from "@/domain/units";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Recording what was actually left on the shelf, spec section 38.
 *
 * Append-only: a count is something that happened at a time, and correcting
 * yesterday's count would move a balance that has already been looked at. A
 * mistaken count is fixed by counting again, which is also what the owner would
 * do with the bottle in their hand.
 *
 * The endpoint takes a quantity in base units. The screen offers rough buckets
 * — «почти пусто», «≈половина» — because that is the question a person can
 * answer about a bottle without a scale, but which bottle it was is something
 * only the screen knows, so the conversion happens there and the honest number
 * is what is stored.
 */

const stockCheckSchema = z.object({
  observed_quantity: z.number().min(0).max(1_000_000),
  basis: z.enum(materialStockCheckBases).default("bucket"),
  checked_at: z.iso.datetime().optional(),
  note: z.string().trim().max(500).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const reqId = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", reqId);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", reqId);
  }

  const actor = caller.membership;
  /*
   * Catalogue scope, like a price.
   *
   * A count is not a record of this master's own work — it re-baselines a
   * balance every other master's low-stock warning is read from, and the
   * calibration suggestion that follows argues about the shared recipe norms.
   * Section 6.1 gives a Master `materials` write scoped to their own visits,
   * which this is not.
   */
  if (!canManageCatalogue(actor.role, "materials")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage materials", reqId);
  }

  const body = await request.json().catch(() => null);
  const parsed = stockCheckSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", reqId, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;

  const created = await withTenant(actor.organizationId, async (tx) => {
    const [material] = await tx.select().from(materials).where(eq(materials.id, id)).limit(1);
    if (!material || material.archivedAt) return null;

    const [check] = await tx
      .insert(materialStockChecks)
      .values({
        organizationId: actor.organizationId,
        materialId: material.id,
        observedQuantityMilliUnits: toMilliUnits(parsed.data.observed_quantity),
        basis: parsed.data.basis,
        checkedAt: parsed.data.checked_at ? new Date(parsed.data.checked_at) : new Date(),
        note: parsed.data.note ?? null,
        createdBy: actor.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "material.stock_checked",
      entityType: "material_stock_check",
      entityId: check.id,
      after: {
        material_id: material.id,
        observed_quantity_milli_units: check.observedQuantityMilliUnits,
        basis: check.basis,
      },
      requestId: reqId,
    });

    return check;
  });

  if (!created) return apiError(404, "MATERIAL_NOT_FOUND", "No material with this ID", reqId);

  return apiSuccess(
    {
      id: created.id,
      observed_quantity_milli_units: created.observedQuantityMilliUnits,
      basis: created.basis,
      checked_at: created.checkedAt,
    },
    reqId,
    201,
  );
}
