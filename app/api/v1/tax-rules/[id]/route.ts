import { eq } from "drizzle-orm";

import { taxRules } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Ending a tax rule.
 *
 * Closed, never deleted, and never edited: the visits that were costed under
 * this rate still need it to exist and to say what it said. A change of rate is
 * a new rule from `POST /tax-rules`, which closes this one at the same instant;
 * this endpoint is for a tax that simply stopped applying.
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
    return apiError(403, "FORBIDDEN", "This role cannot manage tax rules", reqId);
  }

  const { id } = await context.params;

  const closed = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx.select().from(taxRules).where(eq(taxRules.id, id)).limit(1);
    if (!existing || existing.activeTo !== null) return null;

    const [row] = await tx
      .update(taxRules)
      .set({ activeTo: new Date(), updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(taxRules.id, id))
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "tax_rule.closed",
      entityType: "tax_rule",
      entityId: row.id,
      before: { active_to: null },
      after: { active_to: row.activeTo },
      requestId: reqId,
    });

    return row;
  });

  if (!closed) return apiError(404, "TAX_RULE_NOT_FOUND", "No open tax rule with this ID", reqId);

  return apiSuccess({ id: closed.id, active_to: closed.activeTo }, reqId);
}
