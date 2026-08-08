import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { invitations, memberships, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import {
  createInvitationToken,
  effectiveInvitationStatus,
  invitationExpiry,
  normalizeInvitationEmail,
} from "@/domain/invitation";
import { can, canManageRole, memberRoles } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { db } from "@/db";

const createInvitationSchema = z.object({
  // Normalized before the format check, not after: a pasted address carries
  // whitespace, and validating first would reject it as malformed. Case folding
  // here is also what makes the partial unique index on pending invitations
  // meaningful — otherwise the same person could be invited twice.
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: z.enum(memberRoles),
});

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  if (!can(caller.membership.role, "user_management", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage users", id);
  }

  const rows = await withTenant(caller.membership.organizationId, (tx) =>
    tx
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
        acceptedAt: invitations.acceptedAt,
      })
      .from(invitations)
      .orderBy(asc(invitations.createdAt), asc(invitations.id)),
  );

  // The token hash never leaves the database. Status is derived so an expired
  // invitation reads as expired without a job having rewritten the row.
  const data = rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    status: effectiveInvitationStatus(row.status, row.expiresAt),
    expires_at: row.expiresAt,
    created_at: row.createdAt,
    accepted_at: row.acceptedAt,
  }));

  return apiSuccess(data, id);
}

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "user_management", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage users", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = createInvitationSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  // Section 6.1: a Manager administers everyone except an Owner. Without this a
  // Manager could mint an Owner invitation and escalate around the matrix.
  if (!canManageRole(actor.role, parsed.data.role)) {
    return apiError(403, "ROLE_NOT_ASSIGNABLE", "This role cannot grant the requested role", id);
  }

  const email = normalizeInvitationEmail(parsed.data.email);

  const alreadyMember = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.organizationId, actor.organizationId), eq(users.email, email)))
    .limit(1);
  if (alreadyMember.length > 0) {
    return apiError(409, "ALREADY_MEMBER", "This address already belongs to the organization", id);
  }

  const { token, tokenHash } = createInvitationToken(actor.organizationId);

  try {
    const invitation = await withTenant(actor.organizationId, async (tx) => {
      const [created] = await tx
        .insert(invitations)
        .values({
          organizationId: actor.organizationId,
          email,
          role: parsed.data.role,
          tokenHash,
          expiresAt: invitationExpiry(),
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          status: invitations.status,
          expiresAt: invitations.expiresAt,
        });

      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "invitation.created",
        entityType: "invitation",
        entityId: created.id,
        after: { email: created.email, role: created.role },
        requestId: id,
      });

      return created;
    });

    return apiSuccess(
      {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expires_at: invitation.expiresAt,
        token,
      },
      id,
      201,
    );
  } catch (error) {
    if (isUniqueViolation(error, "invitation_pending_email_idx")) {
      return apiError(409, "INVITATION_PENDING", "This address already has a pending invitation", id);
    }
    throw error;
  }
}
