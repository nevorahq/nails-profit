import { and, asc, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";

import { db } from "@/db";
import { memberships, organizations, pilotEnrollments } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { MemberRole } from "@/domain/rbac";
import { getPublicAppUrl, isPilotAccessEnforced } from "@/env";
import { auth } from "@/lib/auth";
import { checkRequestOrigin } from "@/lib/csrf";
import { logEvent } from "@/lib/logger";

export type ActiveMembership = Readonly<{
  userId: string;
  userEmail: string;
  organizationId: string;
  role: MemberRole;
}>;

/**
 * The caller's session together with the organization they act in. Ordering is
 * explicit for the same reason the workspace page orders: without it the active
 * organization could differ between requests.
 */
export async function getActiveMembership(): Promise<
  { session: false } | { session: true; membership: ActiveMembership | null; userId: string }
> {
  const requestHeaders = await headers();

  // Section 7.6 applies CSRF protection to cookie-authenticated mutations. It
  // lives here rather than in each of the twenty-six handlers because this is
  // the one function all of them already call — including the multipart import
  // upload, which is the request a cross-site form can actually forge.
  if (checkRequestOrigin(requestHeaders, getPublicAppUrl()) === "refuse") {
    logEvent(
      "warn",
      "security.cross_site_refused",
      {},
      { sec_fetch_site: requestHeaders.get("sec-fetch-site") },
    );
    // The session exists; it simply does not count for a request the browser
    // says came from someone else's page. The caller answers 401 as it would
    // for any request without one.
    return { session: false };
  }

  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { session: false };

  const [row] = await db
    .select({ organizationId: memberships.organizationId, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    // Deletion removes memberships, so this join is belt and braces: a row left
    // behind by a partial failure must not grant access to a deleted workspace.
    .where(and(eq(memberships.userId, session.user.id), isNull(organizations.deletedAt)))
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(1);

  const pilotStatus =
    row && isPilotAccessEnforced()
      ? await withTenant(row.organizationId, async (tx) => {
          const [enrollment] = await tx
            .select({ status: pilotEnrollments.status })
            .from(pilotEnrollments)
            .limit(1);
          return enrollment?.status ?? null;
        })
      : null;

  return {
    session: true,
    userId: session.user.id,
    membership:
      row &&
      (!isPilotAccessEnforced() || pilotStatus === "active")
      ? {
          userId: session.user.id,
          userEmail: session.user.email,
          organizationId: row.organizationId,
          role: row.role,
        }
        : null,
  };
}
