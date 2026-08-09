import { asc, eq } from "drizzle-orm";

import { DataManagement } from "@/components/data-management";
import { OrganizationSettings } from "@/components/organization-settings";
import { type TeamMember, TeamManager } from "@/components/team-manager";
import { memberships, users } from "@/db/schema";
import { db } from "@/db";
import { can } from "@/domain/rbac";
import { requireWorkspace } from "@/lib/workspace";

export default async function SettingsPage() {
  const { membership, organizationName, organizationSlug, locale, currency } = await requireWorkspace();

  const canReadTeam = can(membership.role, "user_management", "read");
  const canReadOrg = can(membership.role, "organization_settings", "read");
  const canReadData = can(membership.role, "data_export", "read");

  const members: TeamMember[] = canReadTeam
    ? await db
        .select({ user_id: memberships.userId, email: users.email, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(eq(memberships.organizationId, membership.organizationId))
        .orderBy(asc(memberships.createdAt))
    : [];

  return (
    <main className="app-shell">
      {canReadOrg && (
        <OrganizationSettings
          locale={locale}
          currency={currency}
          slug={organizationSlug}
          canEdit={can(membership.role, "organization_settings", "write")}
        />
      )}
      {canReadTeam && (
        <TeamManager
          members={members}
          canManage={can(membership.role, "user_management", "write")}
          locale={locale}
        />
      )}
      {canReadData && (
        <DataManagement
          locale={locale}
          organizationName={organizationName}
          canExport={can(membership.role, "data_export", "read")}
          canDelete={can(membership.role, "data_export", "write")}
        />
      )}
    </main>
  );
}
