import { eq } from "drizzle-orm";

import { db } from "@/db";
import { invitations, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import {
  effectiveInvitationStatus,
  parseInvitationToken,
  type EffectiveInvitationStatus,
} from "@/domain/invitation";
import type { MemberRole } from "@/domain/rbac";
import type { AppLocale } from "@/i18n/messages";

/**
 * What an invitation link says about itself, read before anything is done with
 * it.
 *
 * `/join` used to learn its own state from the error `POST accept` returned,
 * which meant the only way to find out that a link was expired, revoked or
 * addressed to someone else was to press the button that claimed it. Everything
 * a person needs in order to decide — which studio, which address, whether the
 * link is still live — is here instead, resolved on the server before the page
 * renders.
 *
 * Reading it costs nothing an attacker can use. A malformed token is rejected
 * by the regex in `parseInvitationToken` before a query is issued, and a
 * well-formed one is 256 bits of randomness matched against a unique index: the
 * lookup either belongs to the person holding the link or does not resolve. The
 * address it returns is the address the link was mailed to, so the holder of a
 * live link already knows it.
 */
export type InvitationPreview = Readonly<{
  status: EffectiveInvitationStatus;
  email: string;
  role: MemberRole;
  organizationId: string;
  organizationName: string;
  /** The inviting organization's language — the invitee has no other setting. */
  locale: AppLocale;
}>;

export async function previewInvitation(token: string): Promise<InvitationPreview | null> {
  const parsed = parseInvitationToken(token);
  if (!parsed) return null;

  // The organization comes from the token's own prefix, exactly as in the
  // accept path: the reader is not a member yet, so there is no membership to
  // establish tenant context from, and `invitation` is under RLS.
  const invitation = await withTenant(parsed.organizationId, async (tx) => {
    const [row] = await tx
      .select({
        email: invitations.email,
        role: invitations.role,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
        organizationId: invitations.organizationId,
      })
      .from(invitations)
      .where(eq(invitations.tokenHash, parsed.tokenHash))
      .limit(1);
    return row ?? null;
  });

  if (!invitation) return null;

  const [organization] = await db
    .select({ name: organizations.name, locale: organizations.locale })
    .from(organizations)
    .where(eq(organizations.id, invitation.organizationId))
    .limit(1);

  if (!organization) return null;

  return {
    status: effectiveInvitationStatus(invitation.status, invitation.expiresAt),
    email: invitation.email,
    role: invitation.role,
    organizationId: invitation.organizationId,
    organizationName: organization.name,
    locale: organization.locale as AppLocale,
  };
}
