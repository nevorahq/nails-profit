import { asc, eq } from "drizzle-orm";
import { headers } from "next/headers";

import { db } from "@/db";
import { memberships } from "@/db/schema";
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
    .where(eq(memberships.userId, session.user.id))
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
