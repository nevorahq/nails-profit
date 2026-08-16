import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { invitations, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { effectiveInvitationStatus, parseInvitationToken } from "@/domain/invitation";
import { can } from "@/domain/rbac";
import { getPublicAppUrl, isPublicAppUrlReachable } from "@/env";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { logEvent } from "@/lib/logger";
import { getActiveMembership } from "@/lib/membership";
import { notificationProvider } from "@/lib/notification-provider";

const sendSchema = z.object({ token: z.string().min(1).max(500) });

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
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const parsedToken = parseInvitationToken(parsed.data.token);
  if (!parsedToken) {
    return apiError(400, "INVALID_TOKEN", "The invitation token is malformed", id);
  }

  if (parsedToken.organizationId !== actor.organizationId) {
    return apiError(403, "FORBIDDEN", "Token does not belong to your organization", id);
  }

  const [invitation] = await withTenant(actor.organizationId, (tx) =>
    tx
      .select({
        id: invitations.id,
        email: invitations.email,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, parsedToken.tokenHash),
          eq(invitations.organizationId, actor.organizationId),
        ),
      )
      .limit(1),
  );

  if (!invitation) {
    return apiError(404, "NOT_FOUND", "Invitation not found", id);
  }

  const status = effectiveInvitationStatus(invitation.status, invitation.expiresAt);
  if (status !== "pending") {
    return apiError(409, "INVITATION_NOT_PENDING", `Invitation is ${status}`, id);
  }

  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, actor.organizationId))
    .limit(1);

  /*
   * Refused before the message is built, not after it is sent: an invitation
   * carrying `http://localhost:3000/join?token=…` reaches the invitee, looks
   * genuine and cannot be opened by them, and the token is spent from the
   * owner's point of view — the row says "ожидает" while the only working copy
   * of the link sits in the sender's browser.
   */
  if (!isPublicAppUrlReachable()) {
    logEvent("warn", "invitation.email_blocked", {}, { reason: "app_url_not_public", invitation_id: invitation.id });
    return apiError(
      500,
      "APP_URL_NOT_PUBLIC",
      "The application URL is not reachable by the recipient",
      id,
    );
  }

  const joinUrl = `${getPublicAppUrl()}/join?token=${encodeURIComponent(parsed.data.token)}`;
  const orgName = org?.name ?? "Nail Profit OS";

  /*
   * The provider is constructed here rather than at import so a missing
   * credential answers as this endpoint's failure. It used to surface as an
   * unhandled schema error — a 500 with no code, which on the pilot read as
   * "письмо не пришло" with nothing in the interface to say why.
   */
  let provider;
  try {
    provider = notificationProvider();
  } catch (cause) {
    logEvent("error", "invitation.email_misconfigured", {}, {
      invitation_id: invitation.id,
      reason: cause instanceof Error ? cause.name : "unknown",
    });
    return apiError(500, "EMAIL_NOT_CONFIGURED", "The email provider is not configured", id);
  }

  const delivery = await provider.send({
    channel: "email",
    destination: invitation.email,
    subject: `Приглашение в ${orgName}`,
    body: [
      `Вас пригласили присоединиться к ${orgName}.`,
      "",
      `Перейдите по ссылке, чтобы принять приглашение:`,
      joinUrl,
      "",
      `Ссылка действительна 7 дней и привязана к этому email-адресу.`,
      `Войдите или зарегистрируйтесь с адресом: ${invitation.email}`,
    ].join("\n"),
    idempotencyKey: `invitation-send:${invitation.id}`,
  });

  if (!delivery.ok) {
    logEvent("warn", "invitation.email_failed", {}, { code: delivery.code, invitation_id: invitation.id });
    return apiError(502, "EMAIL_FAILED", "Failed to send invitation email", id);
  }

  return apiSuccess({ sent: true, email: invitation.email }, id);
}
