import { asc, eq } from "drizzle-orm";
import { headers } from "next/headers";

import { db } from "@/db";
import { memberships } from "@/db/schema";
import { capabilities, permissionFor, scopeFor, type Capability } from "@/domain/rbac";
import { auth } from "@/lib/auth";
import { apiError, apiSuccess, requestId } from "@/lib/http";

/**
 * The caller's own resolved section 6.1 permissions. A role-aware UI needs this
 * to decide what to render — but per section 6.1 rendering is not access
 * control, so every endpoint still has to check the same matrix server-side.
 *
 * Returns only the caller's own role. It exposes no other member, no client
 * data and nothing about other organizations.
 */
export async function GET(request: Request) {
  const id = requestId(request);
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);

  const [membership] = await db
    .select({ organizationId: memberships.organizationId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, session.user.id))
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(1);

  if (!membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  // `note` stays server-side: it is the spec's Russian wording, not UI copy.
  // Scope is null when the capability is denied — shipping the placeholder
  // "own" would read as "access, limited to your own rows".
  const resolved = Object.fromEntries(
    capabilities.map((capability: Capability) => {
      const { actions, constraints } = permissionFor(membership.role, capability);
      return [
        capability,
        { actions, scope: scopeFor(membership.role, capability), constraints },
      ];
    }),
  );

  return apiSuccess(
    { organization_id: membership.organizationId, role: membership.role, capabilities: resolved },
    id,
  );
}
