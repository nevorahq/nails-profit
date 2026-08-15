import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { memberships, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { adoptPrincipalHistory } from "@/lib/visit-service";

/**
 * Editing a specialist, and above all linking one to an account.
 *
 * Section 6.1 gives a Master scope "own" on visits, clients, commissions and
 * the dashboard, and every one of those lookups resolves through
 * `specialist.user_id`. Until this endpoint existed nothing ever wrote that
 * column: an invited master could sign in and see an empty product, and
 * recording a visit answered FORBIDDEN because no specialist row was theirs.
 * The scope was enforced correctly and applied to nobody.
 *
 * The link is made after the invitation is accepted rather than at creation,
 * because that is the order the accounts appear in: a studio catalogues its
 * masters long before they have logins.
 */
const patchSpecialistSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  cooperation_type: z.enum(["commission", "rent", "staff"]).optional(),
  /** Null unlinks; the specialist and their history stay. */
  user_id: z.string().min(1).nullable().optional(),
  /** The owner who also works. See the column's comment in `db/schema.ts`. */
  is_principal: z.boolean().optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) {
    return apiError(401, "UNAUTHENTICATED", "Authentication is required", requestIdentifier);
  }
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", requestIdentifier);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "commissions")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage specialists", requestIdentifier);
  }

  const body = await request.json().catch(() => null);
  const parsed = patchSpecialistSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", requestIdentifier, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;
  const link = parsed.data.user_id;

  // Membership is checked outside the tenant transaction because it is the one
  // table RLS does not cover. An account from another organization must not
  // become someone's master here — that would hand it a view of this tenant's
  // visits through the "own" scope.
  if (link) {
    const [member] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.organizationId, actor.organizationId), eq(memberships.userId, link)))
      .limit(1);
    if (!member) {
      return apiError(422, "USER_NOT_A_MEMBER", "This account does not belong to the organization", requestIdentifier);
    }
  }

  try {
    const updated = await withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx.select().from(specialists).where(eq(specialists.id, id)).limit(1);
      if (!existing) return null;

      const [specialist] = await tx
        .update(specialists)
        .set({
          ...(parsed.data.name ? { name: parsed.data.name } : {}),
          ...(parsed.data.cooperation_type ? { cooperationType: parsed.data.cooperation_type } : {}),
          ...(link !== undefined ? { userId: link } : {}),
          ...(parsed.data.is_principal !== undefined ? { isPrincipal: parsed.data.is_principal } : {}),
          updatedBy: actor.userId,
          updatedAt: new Date(),
          version: sql`${specialists.version} + 1`,
        })
        .where(eq(specialists.id, id))
        .returning();

      // Marking someone a principal for the first time fills in the answer for
      // the visits that closed before the question existed. See the function.
      if (parsed.data.is_principal === true && !existing.isPrincipal) {
        await adoptPrincipalHistory(tx, id);
      }

      // Who may see which visits changes with this row, so it is audited the
      // way role changes are (section 15.3).
      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "specialist.updated",
        entityType: "specialist",
        entityId: specialist.id,
        before: {
          name: existing.name,
          user_id: existing.userId,
          cooperation_type: existing.cooperationType,
          is_principal: existing.isPrincipal,
        },
        after: {
          name: specialist.name,
          user_id: specialist.userId,
          cooperation_type: specialist.cooperationType,
          is_principal: specialist.isPrincipal,
        },
        requestId: requestIdentifier,
      });

      return specialist;
    });

    if (!updated) {
      return apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", requestIdentifier);
    }

    return apiSuccess(
      {
        id: updated.id,
        name: updated.name,
        cooperation_type: updated.cooperationType,
        user_id: updated.userId,
        is_principal: updated.isPrincipal,
        version: updated.version,
      },
      requestIdentifier,
    );
  } catch (error) {
    if (isUniqueViolation(error, "specialist_org_user_idx")) {
      return apiError(409, "USER_ALREADY_LINKED", "This account is already linked to a specialist", requestIdentifier);
    }
    throw error;
  }
}

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
  if (!canManageCatalogue(actor.role, "commissions")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage specialists", requestIdentifier);
  }

  const { id } = await context.params;

  const archived = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(specialists)
      .where(and(eq(specialists.id, id), isNull(specialists.archivedAt)))
      .limit(1);
    if (!existing) return null;
    if (existing.userId) return { blocked: true } as const;

    const [specialist] = await tx
      .update(specialists)
      .set({ archivedAt: new Date(), updatedBy: actor.userId, updatedAt: new Date(), version: sql`${specialists.version} + 1` })
      .where(eq(specialists.id, id))
      .returning({ id: specialists.id });

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "specialist.archived",
      entityType: "specialist",
      entityId: specialist.id,
      before: { name: existing.name },
      after: { archived_at: new Date().toISOString() },
      requestId: requestIdentifier,
    });

    return specialist;
  });

  if (!archived) return apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", requestIdentifier);
  if ("blocked" in archived) return apiError(409, "SPECIALIST_HAS_ACCOUNT", "Cannot delete a specialist with a linked account", requestIdentifier);

  return apiSuccess({ id: archived.id }, requestIdentifier);
}
