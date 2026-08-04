import { and, asc, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";

import { db } from "@/db";
import { memberships, organizations } from "@/db/schema";
import type { MemberRole } from "@/domain/rbac";
import { auth } from "@/lib/auth";

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
  const session = await auth.api.getSession({ headers: await headers() });
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

  return {
    session: true,
    userId: session.user.id,
    membership: row
      ? {
          userId: session.user.id,
          userEmail: session.user.email,
          organizationId: row.organizationId,
          role: row.role,
        }
      : null,
  };
}
