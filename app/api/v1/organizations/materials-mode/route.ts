import { eq } from "drizzle-orm";
import { z } from "zod";

import { materialsCostingPeriods } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { materialsCostingModes } from "@/domain/materials-mode";
import { can } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { loadMaterialsModes, monthIn } from "@/lib/materials-mode";
import { getActiveMembership } from "@/lib/membership";

/**
 * «Как считать материалы»: how the studio counts its materials, from a month on.
 *
 * Owner only, as the studio's other settings that move its profit are. A month
 * already begun before the current one is refused rather than re-costed: its
 * visits were snapshotted with the mode it had, and the report for it has been
 * read — changing it now would make the purchases and the visits disagree
 * about a month nobody can close again. The current month is allowed, because
 * a studio deciding in the first week means this month.
 *
 * Choosing again for a month already chosen replaces that choice; nothing is
 * ever deleted, so the history of what each month was counted by stays whole.
 */
const schema = z.object({
  mode: z.enum(materialsCostingModes),
  /** `YYYY-MM`. */
  effective_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "organization_settings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot change how materials are counted", id);
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }
  const { mode, effective_month: month } = parsed.data;
  const effectiveFrom = `${month}-01`;

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const modes = await loadMaterialsModes(tx, actor.organizationId);
    if (month < monthIn(new Date(), modes.timezone)) return { refused: true as const };

    const [existing] = await tx
      .select()
      .from(materialsCostingPeriods)
      .where(eq(materialsCostingPeriods.effectiveFrom, effectiveFrom))
      .limit(1);

    const [period] = existing
      ? await tx
          .update(materialsCostingPeriods)
          .set({ mode, updatedBy: actor.userId, updatedAt: new Date() })
          .where(eq(materialsCostingPeriods.id, existing.id))
          .returning()
      : await tx
          .insert(materialsCostingPeriods)
          .values({
            organizationId: actor.organizationId,
            mode,
            effectiveFrom,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          })
          .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "organization.materials_mode_set",
      entityType: "materials_costing_period",
      entityId: period.id,
      before: existing ? { mode: existing.mode, effective_from: existing.effectiveFrom } : null,
      after: { mode: period.mode, effective_from: period.effectiveFrom },
      requestId: id,
    });

    return { refused: false as const, period };
  });

  if (outcome.refused) {
    return apiError(
      409,
      "MATERIALS_MODE_PAST_MONTH",
      "A month before the current one keeps the mode it was counted in",
      id,
    );
  }

  return apiSuccess(
    { mode: outcome.period.mode, effective_from: outcome.period.effectiveFrom },
    id,
    200,
  );
}
