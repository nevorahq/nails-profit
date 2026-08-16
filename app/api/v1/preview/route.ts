import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db";
import { memberships, users } from "@/db/schema";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { logEvent } from "@/lib/logger";
import { getAuthenticatedMembership } from "@/lib/membership";
import { PREVIEW_COOKIE, PREVIEW_COOKIE_MAX_AGE, serializePreview } from "@/lib/preview";

/**
 * Entering and leaving "посмотреть как" — the owner's view of a colleague's
 * interface.
 *
 * Deliberately not a sign-in. Better Auth holds one session per browser origin,
 * so signing in as the master to see the master's screens takes the owner's own
 * session with it: the cookie has one slot, the second sign-in writes it, and
 * the first session — still perfectly valid on the server — becomes unreachable
 * from that browser. This endpoint leaves the session alone and changes only
 * which member the *application* renders for, which is what the owner wanted in
 * the first place.
 *
 * The authenticated caller is read through `getAuthenticatedMembership` rather
 * than `getActiveMembership`, because in preview the latter answers with the
 * previewed member — and an owner two levels in would otherwise be unable to
 * switch targets or leave.
 */
const enterSchema = z.object({ member_user_id: z.string().min(1).max(64) });

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getAuthenticatedMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  // Owner only, and by role rather than by capability: `user_management` would
  // read a manager in too, and a manager has no administrative reason to wear a
  // colleague's screen. Section 6.1 grants nobody else anything this resembles.
  if (actor.role !== "owner") {
    return apiError(403, "FORBIDDEN", "Only an owner may preview another member", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = enterSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const targetUserId = parsed.data.member_user_id;
  if (targetUserId === actor.userId) {
    return apiError(422, "PREVIEW_TARGET_INVALID", "An owner cannot preview themselves", id);
  }

  // The membership is looked up under the actor's own organization, so a
  // substituted id can only ever name a colleague the owner already administers.
  // Nothing here trusts the client beyond the id it is asking about.
  const [target] = await db
    .select({ role: memberships.role, email: users.email, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(
      and(
        eq(memberships.userId, targetUserId),
        eq(memberships.organizationId, actor.organizationId),
      ),
    )
    .limit(1);

  if (!target) {
    return apiError(404, "PREVIEW_TARGET_INVALID", "No such member in this organization", id);
  }
  // Refused so that preview can only ever narrow: an owner holds every
  // capability, so every other role is a subset of what the actor already has,
  // and wearing a second owner's view would be the one case that is not.
  if (target.role === "owner") {
    return apiError(403, "PREVIEW_TARGET_INVALID", "An owner cannot be previewed", id);
  }

  // Read-only preview, so this is a log line rather than an `audit_event` row:
  // there is no mutation to attribute, and the transaction the row would be
  // written in is read-only for the duration of the mode anyway.
  logEvent(
    "info",
    "preview.entered",
    { requestId: id, organizationId: actor.organizationId, userId: actor.userId },
    { target_user_id: targetUserId, target_role: target.role },
  );

  const response = apiSuccess(
    {
      member_user_id: targetUserId,
      email: target.email,
      name: target.name,
      role: target.role,
    },
    id,
  );
  setPreviewCookie(response, serializePreview({ actorUserId: actor.userId, targetUserId }));
  return response;
}

export async function DELETE(request: Request) {
  const id = requestId(request);
  const caller = await getAuthenticatedMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);

  // No role check and no membership requirement on the way out. Leaving is
  // always allowed to succeed: the states that most need an exit are the ones
  // where something else has already gone wrong — a membership revoked, a
  // colleague deleted — and an exit that could itself be refused would strand
  // an owner in a mode they cannot leave.
  const response = apiSuccess({ member_user_id: null }, id);
  response.cookies.delete(PREVIEW_COOKIE);
  return response;
}

/**
 * Written onto the response rather than through `cookies()` from `next/headers`.
 * The E2E suite makes `cookies()` throw so that the session has exactly one way
 * in — the request's cookie header — and a preview that sets its cookie here is
 * one those tests can drive end to end.
 */
function setPreviewCookie(response: NextResponse, value: string) {
  response.cookies.set({
    name: PREVIEW_COOKIE,
    value,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: PREVIEW_COOKIE_MAX_AGE,
  });
}
