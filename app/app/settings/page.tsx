import { AppNav } from "@/components/app-nav";
import { OrganizationSettings } from "@/components/organization-settings";
import { can } from "@/domain/rbac";
import { getTranslator } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

export default async function SettingsPage() {
  const { membership, organizationName, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);

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
        canEdit={can(membership.role, "organization_settings", "write")}
      />
    </main>
  );
}
