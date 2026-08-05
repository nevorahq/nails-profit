import { and, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";

import { db } from "@/db";
import { invitations, memberships } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import {
  effectiveInvitationStatus,
  normalizeInvitationEmail,
  parseInvitationToken,
} from "@/domain/invitation";
import { auth } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, rateLimited, requestId, toFieldErrors } from "@/lib/http";
import { callerKey, checkRateLimit, INVITATION_ACCEPT_RULE } from "@/lib/rate-limit";

// The token travels in the body, not the path: URLs end up in access logs,
// browser history and Referer headers, and this one is a bearer credential.
const acceptSchema = z.object({ token: z.string().min(1).max(200) });

type Failure = { code: string; status: number; message: string };

export async function POST(request: Request) {
  const id = requestId(request);
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);

  // Section 15.3 counts invitation links among the public ones to protect. The
  // token is 256 bits, so this is not about guessing odds — it is about making
  // an attempt cost something.
  const limit = checkRateLimit(callerKey(request, session.user.id), INVITATION_ACCEPT_RULE);
  if (!limit.allowed) return rateLimited(id, limit.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const parsed = acceptSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const token = parseInvitationToken(parsed.data.token);
  // A malformed token is indistinguishable from an unknown one on purpose: both
  // answer INVITATION_INVALID, so the response never confirms that a given
  // organization or invitation exists.
  if (!token) return apiError(404, "INVITATION_INVALID", "The invitation is not valid", id);

  const userEmail = normalizeInvitationEmail(session.user.email);

  const outcome = await withTenant(token.organizationId, async (tx) => {
    // Same policy and the same guard as organization creation: one membership
    // per user for the MVP. Without the lock two accepts race past the check.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${session.user.id}, 0))`);

    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, token.tokenHash))
      .limit(1);

    if (!invitation) {
      return { failure: { code: "INVITATION_INVALID", status: 404, message: "The invitation is not valid" } };
    }

    const status = effectiveInvitationStatus(invitation.status, invitation.expiresAt);
    if (status !== "pending") {
      return {
        failure: {
          code: status === "expired" ? "INVITATION_EXPIRED" : "INVITATION_NOT_PENDING",
          status: 409,
          message: `The invitation is ${status}`,
        },
      };
    }

    // The invitation is addressed to a person, not to whoever holds the link.
    // Without this check a forwarded link would be claimable by anyone.
    if (invitation.email !== userEmail) {
      return {
        failure: {
          code: "INVITATION_EMAIL_MISMATCH",
          status: 403,
          message: "The invitation was issued for a different address",
        },
      };
    }

    const existing = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, session.user.id))
      .limit(1);
    if (existing.length > 0) {
      return {
        failure: {
          code: "MEMBERSHIP_EXISTS",
          status: 409,
          message: "User already belongs to an organization",
        },
      };
    }

    await tx.insert(memberships).values({
      organizationId: invitation.organizationId,
      userId: session.user.id,
      role: invitation.role,
      createdBy: session.user.id,
      updatedBy: session.user.id,
    });

    // Guarded on status so two concurrent accepts cannot both consume the row.
    const consumed = await tx
      .update(invitations)
      .set({
        status: "accepted",
        acceptedBy: session.user.id,
        acceptedAt: new Date(),
        updatedBy: session.user.id,
        updatedAt: new Date(),
        version: sql`${invitations.version} + 1`,
      })
      .where(and(eq(invitations.id, invitation.id), eq(invitations.status, "pending")))
      .returning({ id: invitations.id });

    if (consumed.length === 0) {
      throw new Error("invitation was consumed concurrently");
    }

    await recordAuditEvent(tx, {
      organizationId: invitation.organizationId,
      actorUserId: session.user.id,
      eventType: "invitation.accepted",
      entityType: "membership",
      entityId: invitation.id,
      after: { role: invitation.role, email: invitation.email },
      requestId: id,
    });

    return { organizationId: invitation.organizationId, role: invitation.role };
  });

  if ("failure" in outcome) {
    const failure = outcome.failure as Failure;
    return apiError(failure.status, failure.code, failure.message, id);
  }

  return apiSuccess({ organization_id: outcome.organizationId, role: outcome.role }, id, 201);
}
