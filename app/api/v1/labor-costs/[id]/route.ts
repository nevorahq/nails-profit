import { eq } from "drizzle-orm";

import { laborCostRules } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Ending a labour rule.
 *
 * There is no PATCH here, and its absence is the design: editing a rule in
 * place would rewrite what past months cost, and a salary that silently changes
 * last February is exactly what the versioning exists to prevent. A correction
 * is a new rule from `POST /labor-costs`, which closes this one at the same
 * instant; this endpoint is for stopping a wage that is simply over.
 *
 * Closing rather than deleting, for the same reason: the months it paid for
 * still need it to exist.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const reqId = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", reqId);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", reqId);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "expenses")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage labour costs", reqId);
  }

  const { id } = await context.params;

  const closed = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(laborCostRules)
      .where(eq(laborCostRules.id, id))
      .limit(1);
    if (!existing || existing.activeTo !== null) return null;

    const [row] = await tx
      .update(laborCostRules)
      .set({ activeTo: new Date(), updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(laborCostRules.id, id))
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "labor_cost.closed",
      entityType: "labor_cost_rule",
      entityId: row.id,
      before: { active_to: null },
      after: { active_to: row.activeTo },
      requestId: reqId,
    });

    return row;
  });

  if (!closed) {
    return apiError(404, "LABOR_COST_NOT_FOUND", "No open labour rule with this ID", reqId);
  }

  return apiSuccess({ id: closed.id, active_to: closed.activeTo }, reqId);
}
