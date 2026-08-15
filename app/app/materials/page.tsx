import { ToolIcon } from "@/components/icons";
import { MaterialCatalogue } from "@/components/material-catalogue";
import { can, canManageCatalogue } from "@/domain/rbac";
import { getTranslator } from "@/i18n/t";
import { loadMaterials } from "@/lib/materials";
import { loadMaterialTemplates } from "@/lib/material-templates";
import { requireWorkspace } from "@/lib/workspace";

export default async function MaterialsPage() {
  const { membership, locale } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "materials", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("materials.noAccess")}</p>
      </main>
    );
  }

  const canManage = canManageCatalogue(membership.role, "materials");
  const [rows, templates] = await Promise.all([
    loadMaterials(membership.organizationId),
    // Loaded on the server: the catalogue is 155 rows of product data, and
    // fetching it from the browser would put a spinner in front of the search
    // box the owner is already typing into.
    canManage ? loadMaterialTemplates(locale) : Promise.resolve([]),
  ]);

  return (
    <main className="app-shell">
      {canManage && (
        <header className="app-header">
          <a className="primary-button calendar-create" href="#add-material">
            <ToolIcon name="plus" />
            {t("materials.addMaterial")}
          </a>
          <a
            className="header-action"
            href="#add-material"
            aria-label={t("materials.addMaterial")}
            data-label-closed={t("materials.addMaterial")}
            data-label-open={t("materials.hideAddTitle")}
          >
            <ToolIcon name="plus" />
            <ToolIcon name="minus" />
          </a>
        </header>
      )}
      <MaterialCatalogue
        materials={rows}
        templates={templates}
        locale={locale}
        canManage={canManage}
      />
    </main>
  );
}
