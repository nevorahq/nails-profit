import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import Link from "next/link";

import {
  addOns,
  clients,
  materials,
  materialPriceVersions,
  paymentMethods,
  recipeItems,
  recipes,
  serviceAddOns,
  services,
  specialists,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { VisitCloseForm, type CloseFormAddOn, type CloseFormService } from "@/components/visit-close-form";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator, type Translate } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

async function recipeLines(tx: Parameters<typeof loadCatalogue>[0], target: { serviceId?: string; addOnId?: string }) {
  const [recipe] = await tx
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        target.serviceId ? eq(recipes.serviceId, target.serviceId) : eq(recipes.addOnId, target.addOnId!),
        lte(recipes.activeFrom, new Date()),
      ),
    )
    .orderBy(desc(recipes.activeFrom), desc(recipes.recipeVersion))
    .limit(1);

  if (!recipe) return { configured: false, lines: [] };

  const rows = await tx
    .select({
      materialId: recipeItems.materialId,
      quantity: recipeItems.normativeQuantityMilliUnits,
      materialName: materials.name,
      baseUnit: materials.baseUnit,
    })
    .from(recipeItems)
    .innerJoin(materials, eq(recipeItems.materialId, materials.id))
    .where(eq(recipeItems.recipeId, recipe.id));

  const ids = rows.map((row) => row.materialId);
  const prices =
    ids.length === 0
      ? []
      : await tx
          .selectDistinctOn([materialPriceVersions.materialId], {
            materialId: materialPriceVersions.materialId,
            packagePriceMinor: materialPriceVersions.packagePriceMinor,
            packageSizeMilliUnits: materialPriceVersions.packageSizeMilliUnits,
          })
          .from(materialPriceVersions)
          .where(
            and(
              inArray(materialPriceVersions.materialId, ids),
              lte(materialPriceVersions.validFrom, new Date()),
            ),
          )
          .orderBy(
            materialPriceVersions.materialId,
            desc(materialPriceVersions.validFrom),
            desc(materialPriceVersions.createdAt),
          );
  const priceByMaterial = new Map(prices.map((price) => [price.materialId, price]));

  return {
    configured: true,
    lines: rows.map((row) => ({
      material_id: row.materialId,
      material_name: row.materialName,
      base_unit: row.baseUnit,
      quantity_milli_units: row.quantity,
      package_price_minor: priceByMaterial.get(row.materialId)?.packagePriceMinor ?? null,
      package_size_milli_units: priceByMaterial.get(row.materialId)?.packageSizeMilliUnits ?? null,
    })),
  };
}

async function loadCatalogue(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  locale: string,
  t: Translate,
) {
  const serviceRows = await tx
    .select()
    .from(services)
    .where(isNull(services.archivedAt))
    .orderBy(asc(services.createdAt));

  const addOnRows = await tx.select().from(addOns).where(isNull(addOns.archivedAt));
  const links = await tx.select().from(serviceAddOns);

  const catalogue: CloseFormService[] = await Promise.all(
    serviceRows.map(async (service) => {
      const recipe = await recipeLines(tx, { serviceId: service.id });
      return {
        id: service.id,
        displayName: resolveLocalizedText(service.name, locale as "ru", locale as "ru") ?? t("common.unnamed"),
        price_minor: service.priceMinor,
        duration_minutes: service.durationMinutes,
        standard_profile_configured: recipe.configured,
        recipe: recipe.lines,
      };
    }),
  );

  const options: CloseFormAddOn[] = await Promise.all(
    addOnRows.map(async (addOn) => {
      const recipe = await recipeLines(tx, { addOnId: addOn.id });
      return {
        id: addOn.id,
        displayName: resolveLocalizedText(addOn.name, locale as "ru", locale as "ru") ?? t("common.unnamed"),
        price_delta_minor: addOn.priceDeltaMinor,
        duration_delta_minutes: addOn.durationDeltaMinutes,
        serviceIds: links.filter((link) => link.addOnId === addOn.id).map((link) => link.serviceId),
        standard_profile_configured: recipe.configured,
        recipe: recipe.lines,
      };
    }),
  );

  return { catalogue, options };
}

export default async function NewVisitPage() {
  const { membership, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "bookings", "write")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("closeVisit.noAccess")}</p>
      </main>
    );
  }

  const data = await withTenant(membership.organizationId, async (tx) => {
    const { catalogue, options } = await loadCatalogue(tx, locale, t);
    const people = await tx
      .select({ id: specialists.id, name: specialists.name })
      .from(specialists)
      .where(isNull(specialists.archivedAt))
      .orderBy(asc(specialists.createdAt));
    const clientRows = await tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(isNull(clients.archivedAt))
      .orderBy(asc(clients.name));

    const methods = await tx
      .select({
        id: paymentMethods.id,
        name: paymentMethods.name,
        is_default: paymentMethods.isDefault,
      })
      .from(paymentMethods)
      .where(isNull(paymentMethods.archivedAt))
      .orderBy(asc(paymentMethods.createdAt));

    const materialOptions = await tx
      .select({ id: materials.id, name: materials.name, base_unit: materials.baseUnit })
      .from(materials)
      .where(isNull(materials.archivedAt))
      .orderBy(asc(materials.name));

    return { catalogue, options, people, clientRows, methods, materialOptions };
  });

  return (
    <main className="app-shell">
      <header className="app-header app-header-split">
        <h1>{t("closeVisit.title")}</h1>
        <Link className="text-link" href="/app/visits">
          ← {t("visits.title")}
        </Link>
      </header>
      <VisitCloseForm
        services={data.catalogue}
        addOns={data.options}
        specialists={data.people}
        clients={data.clientRows}
        paymentMethods={data.methods}
        extraMaterials={data.materialOptions}
        currency={currency}
        locale={locale}
      />
    </main>
  );
}
