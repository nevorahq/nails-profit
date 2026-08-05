import { asc, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";

import { materialPriceVersions, materials } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { baseUnitCostMinor } from "@/domain/units";
import { MaterialCatalogue, type MaterialRow } from "@/components/material-catalogue";
import { requireWorkspace } from "@/lib/workspace";

export default async function MaterialsPage() {
  const { membership, organizationName } = await requireWorkspace();

  if (!can(membership.role, "materials", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">У вашей роли нет доступа к материалам.</p>
      </main>
    );
  }

  const rows = await loadMaterials(membership.organizationId);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">{organizationName}</span>
          <h1>Материалы</h1>
        </div>
        <nav className="tab-nav">
          <Link href="/app/services">Услуги</Link>
          <Link className="active" href="/app/materials">
            Материалы
          </Link>
          <Link href="/app/specialists">Мастера</Link>
        </nav>
      </header>
      <MaterialCatalogue materials={rows} />
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
