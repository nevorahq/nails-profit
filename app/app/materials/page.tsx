import { asc, desc, eq, isNull } from "drizzle-orm";
import { AppNav } from "@/components/app-nav";

import { materialPriceVersions, materials } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { baseUnitCostMinor } from "@/domain/units";
import { MaterialCatalogue, type MaterialRow } from "@/components/material-catalogue";
import { getTranslator } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

export default async function MaterialsPage() {
  const { membership, organizationName, locale } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "materials", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("materials.noAccess")}</p>
      </main>
    );
  }

  const rows = await loadMaterials(membership.organizationId);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">{organizationName}</span>
          <h1>{t("materials.title")}</h1>
        </div>
        <AppNav active="/app/materials" locale={locale} role={membership.role} />
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
