import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import { AppNav } from "@/components/app-nav";

import { addOns, materials, recipeItems, recipes } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { AddOnCatalogue, type AddOnRow } from "@/components/add-on-catalogue";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { loadMaterials } from "@/app/app/materials/page";
import { getTranslator } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

export default async function AddOnsPage() {
  const { membership, organizationName, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "services", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("services.noAccess")}</p>
      </main>
    );
  }

  const rows: AddOnRow[] = await withTenant(membership.organizationId, async (tx) => {
    const catalogue = await tx
      .select()
      .from(addOns)
      .where(isNull(addOns.archivedAt))
      .orderBy(asc(addOns.createdAt));

    return Promise.all(
      catalogue.map(async (addOn) => {
        const [recipe] = await tx
          .select({ id: recipes.id })
          .from(recipes)
          .where(and(eq(recipes.addOnId, addOn.id), lte(recipes.activeFrom, new Date())))
          .orderBy(desc(recipes.activeFrom), desc(recipes.recipeVersion))
          .limit(1);

        const lines = recipe
          ? await tx
              .select({
                materialId: recipeItems.materialId,
                quantity: recipeItems.normativeQuantityMilliUnits,
                materialName: materials.name,
                baseUnit: materials.baseUnit,
              })
              .from(recipeItems)
              .innerJoin(materials, eq(recipeItems.materialId, materials.id))
              .where(eq(recipeItems.recipeId, recipe.id))
              .orderBy(materials.name)
          : [];

        return {
          id: addOn.id,
          displayName: resolveLocalizedText(addOn.name, locale, locale) ?? t("common.unnamed"),
          price_delta_minor: addOn.priceDeltaMinor,
          duration_delta_minutes: addOn.durationDeltaMinutes,
          recipe: lines.map((line) => ({
            material_id: line.materialId,
            material_name: line.materialName,
            base_unit: line.baseUnit,
            quantity_milli_units: line.quantity,
          })),
        };
      }),
    );
  });

  const materialRows = await loadMaterials(membership.organizationId);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">{organizationName}</span>
          <h1>{t("addOns.title")}</h1>
        </div>
        <AppNav active="/app/add-ons" locale={locale} role={membership.role} />
      </header>
      <AddOnCatalogue
        addOns={rows}
        materials={materialRows}
        currency={currency}
        locale={locale}
        canManage={canManageCatalogue(membership.role, "services")}
      />
    </main>
  );
}
