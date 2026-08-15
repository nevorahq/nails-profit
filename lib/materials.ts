import { asc, desc, inArray, isNull } from "drizzle-orm";

import { materialPriceVersions, materials } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { baseUnitCostMinor } from "@/domain/units";

/**
 * The material catalogue with its current purchase price.
 *
 * This lived in the `/app/materials` page module while that page listed
 * materials. The page is the expense ledger now and answers on `/app/expenses`,
 * so the loader moved here: the recipe editor and the add-on catalogue are the
 * things that read it, and neither has anything to do with expenses.
 */
export type MaterialRow = {
  id: string;
  name: string;
  /** Stable generic key used only to map opt-in system recipe presets. */
  system_key: string | null;
  base_unit: string;
  /** E3.1 §F2: an average standing for a group, or one purchasable package. */
  kind: "sku" | "aggregate";
  /**
   * E3.1 §F5. Shown on the card at all times, not only while creating: a number
   * the owner is deciding a price from should say where it came from whenever
   * they look at it.
   */
  source: "manual" | "template" | "bulk_paste" | "import";
  current_price: {
    package_price_minor: number;
    package_size_milli_units: number;
    costing_mode: "quantity" | "services_per_package" | "fixed_per_service";
    currency: string;
    /** Null when the package size is unknown — never zero, which would read as free. */
    base_unit_cost_minor: number | null;
  } | null;
  price_history: Array<{
    id: string;
    package_price_minor: number;
    package_size_milli_units: number;
    costing_mode: "quantity" | "services_per_package" | "fixed_per_service";
    price_source: "manual" | "template" | "bulk_paste" | "import";
    currency: string;
    valid_from: string;
  }>;
};

export async function loadMaterials(organizationId: string): Promise<MaterialRow[]> {
  return withTenant(organizationId, async (tx) => {
    const catalogue = await tx
      .select()
      .from(materials)
      .where(isNull(materials.archivedAt))
      .orderBy(asc(materials.name));

    const prices = catalogue.length
      ? await tx
          .select({
            id: materialPriceVersions.id,
            materialId: materialPriceVersions.materialId,
            packagePriceMinor: materialPriceVersions.packagePriceMinor,
            packageSizeMilliUnits: materialPriceVersions.packageSizeMilliUnits,
            costingMode: materialPriceVersions.costingMode,
            priceSource: materialPriceVersions.priceSource,
            currency: materialPriceVersions.currency,
            validFrom: materialPriceVersions.validFrom,
          })
          .from(materialPriceVersions)
          .where(inArray(materialPriceVersions.materialId, catalogue.map((material) => material.id)))
          .orderBy(
            materialPriceVersions.materialId,
            desc(materialPriceVersions.validFrom),
            desc(materialPriceVersions.createdAt),
          )
      : [];

    const pricesByMaterial = new Map<string, typeof prices>();
    for (const price of prices) {
      const history = pricesByMaterial.get(price.materialId) ?? [];
      history.push(price);
      pricesByMaterial.set(price.materialId, history);
    }

    return catalogue.map((material) => {
      const history = pricesByMaterial.get(material.id) ?? [];
      const price = history[0];
      return {
        id: material.id,
        name: material.name,
        system_key: material.sku?.startsWith("SYSTEM:")
          ? material.sku.slice("SYSTEM:".length).toLowerCase()
          : null,
        base_unit: material.baseUnit,
        kind: material.kind,
        source: material.source,
        current_price: price
          ? {
              package_price_minor: price.packagePriceMinor,
              package_size_milli_units: price.packageSizeMilliUnits,
              costing_mode: price.costingMode,
              currency: price.currency,
              base_unit_cost_minor: baseUnitCostMinor(
                price.packagePriceMinor,
                price.packageSizeMilliUnits,
              ),
            }
          : null,
        price_history: history.map((version) => ({
          id: version.id,
          package_price_minor: version.packagePriceMinor,
          package_size_milli_units: version.packageSizeMilliUnits,
          costing_mode: version.costingMode,
          price_source: version.priceSource,
          currency: version.currency,
          valid_from: version.validFrom.toISOString(),
        })),
      };
    });
  });
}
