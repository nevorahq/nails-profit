import { asc, eq } from "drizzle-orm";

import { AppNav } from "@/components/app-nav";
import { DataManagement } from "@/components/data-management";
import { OrganizationSettings } from "@/components/organization-settings";
import { type TeamMember, TeamManager } from "@/components/team-manager";
import { memberships, users } from "@/db/schema";
import { db } from "@/db";
import { can } from "@/domain/rbac";
import { getTranslator } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

export default async function SettingsPage() {
  const { membership, organizationName, organizationSlug, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);

  const members: TeamMember[] = await db
    .select({ user_id: memberships.userId, email: users.email, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.organizationId, membership.organizationId))
    .orderBy(asc(memberships.createdAt));

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">{organizationName}</span>
          <h1>{t("settings.title")}</h1>
        </div>
        <AppNav active="/app/settings" locale={locale} />
      </header>

      <OrganizationSettings
        locale={locale}
        currency={currency}
        slug={organizationSlug}
        canEdit={can(membership.role, "organization_settings", "write")}
      />
      <TeamManager
        members={members}
        canManage={can(membership.role, "user_management", "write")}
        locale={locale}
      />
      <DataManagement
        locale={locale}
        organizationName={organizationName}
        canExport={can(membership.role, "data_export", "read")}
        canDelete={can(membership.role, "data_export", "write")}
      />
    </main>
  );
}
