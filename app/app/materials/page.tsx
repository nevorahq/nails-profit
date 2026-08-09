import { asc, desc, eq, isNull } from "drizzle-orm";

import { ToolIcon } from "@/components/icons";
import { materialPriceVersions, materials } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { baseUnitCostMinor } from "@/domain/units";
import { MaterialCatalogue, type MaterialRow } from "@/components/material-catalogue";
import { getTranslator } from "@/i18n/t";
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

  const rows = await loadMaterials(membership.organizationId);
  const canWrite = can(membership.role, "materials", "write");

  return (
    <main className="app-shell">
      <header className="app-header">
        {/*
          The compose action. Two shapes of the one control, exactly as the
          calendar's own toolbar and round button are (`app/app/calendar/page.tsx`):
          a labelled toggle for a desktop, a round one for a phone. Both point
          at the add-material `<details>` `components/material-catalogue.tsx`
          renders further down the page; the click handling that opens (and,
          for either anchor, closes) it lives there, since this is a Server
          Component and cannot hold it.
        */}
        {canWrite && (
          <a className="primary-button calendar-create" href="#add-material">
            <ToolIcon name="plus" />
            {t("materials.addMaterial")}
          </a>
        )}
        {canWrite && (
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
        )}
      </header>
      <MaterialCatalogue materials={rows} locale={locale} />
    </main>
  );
}

export async function loadMaterials(organizationId: string): Promise<MaterialRow[]> {
  return withTenant(organizationId, async (tx) => {
    const catalogue = await tx
      .select()
      .from(materials)
      .where(isNull(materials.archivedAt))
      .orderBy(asc(materials.name));

    return Promise.all(
      catalogue.map(async (material) => {
        const [price] = await tx
          .select({
            packagePriceMinor: materialPriceVersions.packagePriceMinor,
            packageSizeMilliUnits: materialPriceVersions.packageSizeMilliUnits,
            currency: materialPriceVersions.currency,
          })
          .from(materialPriceVersions)
          .where(eq(materialPriceVersions.materialId, material.id))
          .orderBy(desc(materialPriceVersions.validFrom), desc(materialPriceVersions.createdAt))
          .limit(1);

        return {
          id: material.id,
          name: material.name,
          base_unit: material.baseUnit,
          current_price: price
            ? {
                package_price_minor: price.packagePriceMinor,
                package_size_milli_units: price.packageSizeMilliUnits,
                currency: price.currency,
                base_unit_cost_minor: baseUnitCostMinor(
                  price.packagePriceMinor,
                  price.packageSizeMilliUnits,
                ),
              }
            : null,
        };
      }),
    );
  });
}
