import { and, eq, sql } from "drizzle-orm";

import { invitations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Revokes a pending invitation. Needed operationally: an invitation sent to the
 * wrong address is a live credential until it is cancelled or expires.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) {
    return apiError(401, "UNAUTHENTICATED", "Authentication is required", requestIdentifier);
  }
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", requestIdentifier);
  }

  const actor = caller.membership;
  if (!can(actor.role, "user_management", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage users", requestIdentifier);
  }

  const { id } = await context.params;

  const revoked = await withTenant(actor.organizationId, async (tx) => {
    // Section 6.2: an ID from another tenant must answer 404, not 403. RLS makes
    // that automatic here — the row is simply not visible, so the update matches
    // nothing and the caller cannot tell the two cases apart.
    const rows = await tx
      .update(invitations)
      .set({
        status: "revoked",
        updatedBy: actor.userId,
        updatedAt: new Date(),
        version: sql`${invitations.version} + 1`,
      })
      .where(and(eq(invitations.id, id), eq(invitations.status, "pending")))
      .returning({ id: invitations.id, email: invitations.email, role: invitations.role });

    if (rows.length === 0) return null;

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "invitation.revoked",
      entityType: "invitation",
      entityId: rows[0].id,
      before: { email: rows[0].email, role: rows[0].role, status: "pending" },
      after: { status: "revoked" },
      requestId: requestIdentifier,
    });

    return rows[0];
  });

  if (!revoked) {
    return apiError(404, "INVITATION_NOT_FOUND", "No pending invitation with this ID", requestIdentifier);
  }

  return apiSuccess({ id: revoked.id, status: "revoked" }, requestIdentifier);
}
