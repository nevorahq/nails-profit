import { and, count, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { memberships, sessions, specialists, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageRole } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { logEvent } from "@/lib/logger";
import { getActiveMembership } from "@/lib/membership";

/**
 * Removing a colleague from the studio.
 *
 * What this is not: deleting their account. The row in `user` belongs to the
 * person, not to the studio that invited them — and the schema agrees, in the
 * hard way. `material_price_version.created_by` is `ON DELETE restrict`, so a
 * colleague who ever priced a material cannot be deleted at all, and every
 * `created_by`, `updated_by` and `audit_event.actor_user_id` is `set null`,
 * so a deletion that did succeed would empty the actor out of the very journal
 * kept to say who did what. Ending the relationship is the operation that
 * exists; ending the person is not one this product should offer.
 *
 * So three things happen, and the money is not among them:
 *
 *   1. the membership goes, which is what every permission check reads;
 *   2. the specialist row is unlinked and archived — the studio's record of a
 *      person stays, and their visits, commissions and financial snapshots keep
 *      pointing at it, correctly attributed;
 *   3. their sessions are revoked, so the browser they left open stops being
 *      signed in rather than drifting into the "create a workspace" screen with
 *      a live session.
 *
 * Archived rather than deleted even when the person never worked a day. The
 * endpoint that does delete a specialist already exists and refuses while an
 * account is linked (`app/api/v1/specialists/[id]/route.ts`); unlinking here is
 * exactly what unblocks it, so an owner who wants the row gone can now have
 * that, deliberately, in one more click. Doing it for them as a side effect of
 * removing a member would be an irreversible act nobody asked for.
 */
type Failure = { code: string; status: number };

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "user_management", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage the team", id);
  }

  const { id: membershipId } = await context.params;

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    /*
     * `membership` is one of the two tables deliberately left outside the
     * org-scoped RLS policies — it is the lookup that *establishes* the tenant,
     * so a policy reading the tenant setting would make it return nothing (see
     * `drizzle/0022_identity_tables_rls.sql`). The organization filter below is
     * therefore the tenant boundary itself, not a convenience: without it a
     * membership id from another studio would be found and deleted.
     */
    const [target] = await tx
      .select({
        userId: memberships.userId,
        role: memberships.role,
        email: users.email,
        name: users.name,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(
        and(eq(memberships.id, membershipId), eq(memberships.organizationId, actor.organizationId)),
      )
      .limit(1);

    if (!target) return { failure: { code: "MEMBER_NOT_FOUND", status: 404 } } as const;

    /*
     * Nobody removes themselves. An owner doing it would leave a studio with
     * data and no one able to administer it, and for everyone else it is a
     * footgun with no use case — leaving is not something the team screen has
     * ever been asked to do. Refusing is also what makes the last-owner
     * invariant below hold with a single count.
     */
    if (target.userId === actor.userId) {
      return { failure: { code: "SELF_REMOVAL_FORBIDDEN", status: 409 } } as const;
    }

    // Section 6.1: a Manager administers users "кроме Owner".
    if (!canManageRole(actor.role, target.role)) {
      return { failure: { code: "ROLE_NOT_MANAGEABLE", status: 403 } } as const;
    }

    if (target.role === "owner") {
      const [{ value: owners }] = await tx
        .select({ value: count() })
        .from(memberships)
        .where(
          and(eq(memberships.organizationId, actor.organizationId), eq(memberships.role, "owner")),
        );
      // Unreachable while self-removal is refused and only an owner may manage
      // an owner — two owners must exist for this call to get here. Kept
      // because it is the invariant that matters, and the two rules above are
      // free to change.
      if (owners <= 1) return { failure: { code: "LAST_OWNER", status: 409 } } as const;
    }

    /*
     * Unlinked and archived in one statement. `coalesce` rather than a fresh
     * timestamp so re-archiving an already archived specialist does not rewrite
     * the day they actually stopped working.
     */
    const [specialist] = await tx
      .update(specialists)
      .set({
        userId: null,
        archivedAt: sql`coalesce(${specialists.archivedAt}, now())`,
        updatedBy: actor.userId,
        updatedAt: new Date(),
        version: sql`${specialists.version} + 1`,
      })
      .where(
        and(
          eq(specialists.organizationId, actor.organizationId),
          eq(specialists.userId, target.userId),
        ),
      )
      .returning({ id: specialists.id, name: specialists.name });

    await tx
      .delete(memberships)
      .where(
        and(eq(memberships.id, membershipId), eq(memberships.organizationId, actor.organizationId)),
      );

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "membership.removed",
      entityType: "membership",
      entityId: membershipId,
      before: { email: target.email, role: target.role },
      after: { specialist_archived: specialist?.id ?? null },
      requestId: id,
    });

    return {
      userId: target.userId,
      email: target.email,
      role: target.role,
      specialistId: specialist?.id ?? null,
    };
  });

  if ("failure" in outcome) {
    // Narrowed by hand, as `app/api/v1/invitations/accept/route.ts` does: the
    // branches return object literals, and the inferred union is wider than the
    // `in` check can sharpen on its own.
    const failure = outcome.failure as Failure;
    return apiError(failure.status, failure.code, FAILURE_MESSAGES[failure.code], id);
  }

  /*
   * After the transaction commits, and outside it: `session` is an identity
   * table with no organization of its own, so it is not the tenant
   * transaction's to write. Doing it second also means a membership that failed
   * to be removed never costs someone their sign-in.
   *
   * Deleting the rows is what revokes them. Better Auth resolves every request
   * by looking its cookie token up in this table, and the session cookie cache
   * is off (see `lib/auth.ts`), so there is no signed copy of the session left
   * to outlive the row.
   */
  const revoked = await db
    .delete(sessions)
    .where(eq(sessions.userId, outcome.userId))
    .returning({ id: sessions.id });

  logEvent(
    "info",
    "membership.removed",
    { requestId: id, organizationId: actor.organizationId, userId: actor.userId },
    { removed_user_id: outcome.userId, removed_role: outcome.role, sessions_revoked: revoked.length },
  );

  return apiSuccess(
    {
      user_id: outcome.userId,
      email: outcome.email,
      role: outcome.role,
      specialist_archived: outcome.specialistId,
      sessions_revoked: revoked.length,
    },
    id,
  );
}

const FAILURE_MESSAGES: Record<string, string> = {
  MEMBER_NOT_FOUND: "No such member in this organization",
  SELF_REMOVAL_FORBIDDEN: "You cannot remove yourself from the organization",
  ROLE_NOT_MANAGEABLE: "This role cannot be removed by you",
  LAST_OWNER: "The last owner cannot be removed",
};
