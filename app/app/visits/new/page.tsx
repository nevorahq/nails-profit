import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import Link from "next/link";

import { addOns, clients, materials, recipeItems, recipes, serviceAddOns, services, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { VisitCloseForm, type CloseFormAddOn, type CloseFormService } from "@/components/visit-close-form";
import { resolveLocalizedText } from "@/i18n/localized-text";
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

  if (!recipe) return [];

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

  return rows.map((row) => ({
    material_id: row.materialId,
    material_name: row.materialName,
    base_unit: row.baseUnit,
    quantity_milli_units: row.quantity,
  }));
}

async function loadCatalogue(tx: Parameters<Parameters<typeof withTenant>[1]>[0], locale: string) {
  const serviceRows = await tx
    .select()
    .from(services)
    .where(isNull(services.archivedAt))
    .orderBy(asc(services.createdAt));

  const addOnRows = await tx.select().from(addOns).where(isNull(addOns.archivedAt));
  const links = await tx.select().from(serviceAddOns);

  const catalogue: CloseFormService[] = await Promise.all(
    serviceRows.map(async (service) => ({
      id: service.id,
      displayName: resolveLocalizedText(service.name, locale as "ru", locale as "ru") ?? "Без названия",
      price_minor: service.priceMinor,
      duration_minutes: service.durationMinutes,
      recipe: await recipeLines(tx, { serviceId: service.id }),
    })),
  );

  const options: CloseFormAddOn[] = await Promise.all(
    addOnRows.map(async (addOn) => ({
      id: addOn.id,
      displayName: resolveLocalizedText(addOn.name, locale as "ru", locale as "ru") ?? "Без названия",
      price_delta_minor: addOn.priceDeltaMinor,
      duration_delta_minutes: addOn.durationDeltaMinutes,
      serviceIds: links.filter((link) => link.addOnId === addOn.id).map((link) => link.serviceId),
      recipe: await recipeLines(tx, { addOnId: addOn.id }),
    })),
  );

  return { catalogue, options };
}

export default async function NewVisitPage() {
  const { membership, organizationName, locale, currency } = await requireWorkspace();

  if (!can(membership.role, "bookings", "write")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">У вашей роли нет права записывать визиты.</p>
      </main>
    );
  }

  const data = await withTenant(membership.organizationId, async (tx) => {
    const { catalogue, options } = await loadCatalogue(tx, locale);
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

    return { catalogue, options, people, clientRows };
  });

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">{organizationName}</span>
          <h1>Закрыть визит</h1>
        </div>
        <Link className="text-link" href="/app/visits">
          ← История
        </Link>
      </header>
      <VisitCloseForm
        services={data.catalogue}
        addOns={data.options}
        specialists={data.people}
        clients={data.clientRows}
        currency={currency}
      />
    </main>
  );
}
