import { desc, eq, inArray, isNull } from "drizzle-orm";

import { consumptions, materialPurchases, materialStockChecks, materials, visits } from "@/db/schema";
import { withTenant, type TenantTransaction } from "@/db/tenant";
import {
  averageUsagePerVisitMilliUnits,
  calibrationSuggestion,
  estimateStock,
  purchaseAverages,
  remainingServices,
  stockStatus,
  type CalibrationSuggestion,
  type MaterialStockCheckBasis,
  type StockConsumptionEvent,
  type StockStatus,
} from "@/domain/material-stock";

/**
 * The estimated balance of every material, assembled for the catalogue screen.
 *
 * Four queries for the whole catalogue rather than four per material: the
 * arithmetic is a fold over three lists, so the lists are fetched whole and
 * grouped in memory. A studio with 40 materials and a year of visits is a few
 * thousand rows, which is smaller than the dashboard already reads.
 *
 * Kept out of `loadMaterials` on purpose. That loader also answers the recipe
 * editor and the add-on catalogue, and neither of them has any use for a
 * balance — making them pay for three more queries to render a dropdown would
 * be the wrong trade.
 */

export type MaterialStockRow = {
  material_id: string;
  /** Thousandths of the base unit. Null means nothing is known, never zero. */
  balance_milli_units: number | null;
  basis: "check" | "purchases" | "unknown";
  baseline_at: string | null;
  /** The balance restated the way the owner thinks about it. */
  remaining_services: number | null;
  /** What a visit using this material spends on average, measured from history. */
  usage_per_service_milli_units: number | null;
  status: StockStatus;
  average_package_cost_minor: number | null;
  average_base_unit_cost_minor: number | null;
  packages_purchased: number;
  total_spent_minor: number;
  last_purchase: {
    id: string;
    purchased_at: string;
    package_quantity: number;
    package_size_milli_units: number;
    unit_package_cost_minor: number;
    currency: string;
    supplier: string | null;
  } | null;
  last_check: {
    checked_at: string;
    observed_quantity_milli_units: number;
    basis: MaterialStockCheckBasis;
  } | null;
  /**
   * How far the last count was from what the estimate predicted. Null until a
   * count exists to compare against.
   */
  calibration: CalibrationSuggestion | null;
};

/**
 * Consumption as stock events, effective quantity and visit date.
 *
 * `actual ?? normative` mirrors `resolveEffectiveMaterialUsage`, which resolves
 * the same choice for money. The correction wins where there is one, and an
 * explicit zero stays a zero — a material the master removed from the visit did
 * not leave the shelf.
 *
 * Dated by `visit.completed_at` rather than by the row's own `created_at`: a
 * visit entered three days late consumed its materials on the day it happened,
 * and the baseline comparison against a stock check depends on that being true.
 */
async function loadConsumptionEvents(tx: TenantTransaction) {
  return tx
    .select({
      materialId: consumptions.materialId,
      normative: consumptions.normativeQuantityMilliUnits,
      actual: consumptions.actualQuantityMilliUnits,
      at: visits.completedAt,
    })
    .from(consumptions)
    .innerJoin(visits, eq(consumptions.visitId, visits.id));
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(key(row));
    if (bucket) bucket.push(row);
    else grouped.set(key(row), [row]);
  }
  return grouped;
}

export async function loadMaterialStock(
  organizationId: string,
  options: { asOf?: Date } = {},
): Promise<MaterialStockRow[]> {
  return withTenant(organizationId, async (tx) => {
    const catalogue = await tx
      .select({ id: materials.id })
      .from(materials)
      .where(isNull(materials.archivedAt));

    if (catalogue.length === 0) return [];

    const materialIds = catalogue.map((material) => material.id);

    const [purchaseRows, consumptionRows, checkRows] = await Promise.all([
      tx
        .select()
        .from(materialPurchases)
        .where(inArray(materialPurchases.materialId, materialIds))
        .orderBy(desc(materialPurchases.purchasedAt)),
      loadConsumptionEvents(tx),
      tx
        .select()
        .from(materialStockChecks)
        .where(inArray(materialStockChecks.materialId, materialIds))
        .orderBy(desc(materialStockChecks.checkedAt)),
    ]);

    const purchasesByMaterial = groupBy(purchaseRows, (row) => row.materialId);
    const consumptionsByMaterial = groupBy(consumptionRows, (row) => row.materialId);
    const checksByMaterial = groupBy(checkRows, (row) => row.materialId);

    return catalogue.map((material): MaterialStockRow => {
      const purchases = purchasesByMaterial.get(material.id) ?? [];
      const checks = checksByMaterial.get(material.id) ?? [];
      const usage: StockConsumptionEvent[] = (consumptionsByMaterial.get(material.id) ?? []).map(
        (row) => ({ at: row.at, quantityMilliUnits: row.actual ?? row.normative }),
      );

      const balance = estimateStock({
        purchases: purchases.map((row) => ({
          at: row.purchasedAt,
          quantityMilliUnits: row.packageQuantity * row.packageSizeMilliUnits,
        })),
        consumptions: usage,
        checks: checks.map((row) => ({
          at: row.checkedAt,
          observedQuantityMilliUnits: row.observedQuantityMilliUnits,
        })),
        ...(options.asOf ? { asOf: options.asOf } : {}),
      });

      const perService = averageUsagePerVisitMilliUnits(usage);
      const servicesLeft = remainingServices(balance.milliUnits, perService);
      const averages = purchaseAverages(
        purchases.map((row) => ({
          packageQuantity: row.packageQuantity,
          packageSizeMilliUnits: row.packageSizeMilliUnits,
          unitPackageCostMinor: row.unitPackageCostMinor,
        })),
      );

      const lastPurchase = purchases[0] ?? null;
      const lastCheck = checks[0] ?? null;

      return {
        material_id: material.id,
        balance_milli_units: balance.milliUnits,
        basis: balance.basis,
        baseline_at: balance.baselineAt?.toISOString() ?? null,
        remaining_services: servicesLeft,
        usage_per_service_milli_units: perService,
        status: stockStatus(balance.milliUnits, servicesLeft),
        average_package_cost_minor: averages.averagePackageCostMinor,
        average_base_unit_cost_minor: averages.averageBaseUnitCostMinor,
        packages_purchased: averages.packagesPurchased,
        total_spent_minor: averages.totalSpentMinor,
        last_purchase: lastPurchase
          ? {
              id: lastPurchase.id,
              purchased_at: lastPurchase.purchasedAt.toISOString(),
              package_quantity: lastPurchase.packageQuantity,
              package_size_milli_units: lastPurchase.packageSizeMilliUnits,
              unit_package_cost_minor: lastPurchase.unitPackageCostMinor,
              currency: lastPurchase.currency,
              supplier: lastPurchase.supplier,
            }
          : null,
        last_check: lastCheck
          ? {
              checked_at: lastCheck.checkedAt.toISOString(),
              observed_quantity_milli_units: lastCheck.observedQuantityMilliUnits,
              basis: lastCheck.basis,
            }
          : null,
        calibration: buildCalibration(purchases, usage, checks),
      };
    });
  });
}

/**
 * What the estimate would have said at the moment of the last count.
 *
 * Computed by re-running the balance against the count *before* the newest one,
 * so "expected" is the prediction the count actually tested. With only one
 * count there is nothing to have predicted from except the purchases, which is
 * exactly the first-calibration case.
 */
function buildCalibration(
  purchases: readonly (typeof materialPurchases.$inferSelect)[],
  usage: readonly StockConsumptionEvent[],
  checks: readonly (typeof materialStockChecks.$inferSelect)[],
): CalibrationSuggestion | null {
  const latest = checks[0];
  if (!latest) return null;

  const predicted = estimateStock({
    purchases: purchases.map((row) => ({
      at: row.purchasedAt,
      quantityMilliUnits: row.packageQuantity * row.packageSizeMilliUnits,
    })),
    consumptions: usage,
    checks: checks.slice(1).map((row) => ({
      at: row.checkedAt,
      observedQuantityMilliUnits: row.observedQuantityMilliUnits,
    })),
    asOf: latest.checkedAt,
  });

  if (predicted.milliUnits === null) return null;

  return calibrationSuggestion(
    predicted.milliUnits,
    latest.observedQuantityMilliUnits,
    predicted.consumedSinceMilliUnits,
  );
}
