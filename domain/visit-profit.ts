import { calculateCosting, type Commission, type CostingResult } from "@/domain/costing";
import type { Currency } from "@/domain/money";
import { roundRatio } from "@/domain/money";
import { materialCostMinor } from "@/domain/units";

/**
 * Profit of a completed visit, spec section 8.8.1 and CST-006/CST-007.
 *
 * Everything here is a snapshot taken when the visit was closed. That is the
 * whole point: raising a supplier price or editing a recipe tomorrow must not
 * change what a visit last month earned. The caller passes copies, never
 * references to catalogue rows.
 *
 * A material's snapshot is its package price and package size, not a rounded
 * per-unit cost. The spec calls the field `unit_cost_snapshot`; storing the
 * package pair instead keeps the arithmetic exact, because a rounded per-unit
 * price multiplied by a quantity rounds twice — the same reason
 * `materialCostMinor` exists.
 */

export type VisitLineSnapshot = Readonly<{
  /** What was sold: the service itself or one of its add-ons. */
  kind: "service" | "add_on";
  priceMinor: number;
  discountMinor: number;
}>;

export type ConsumptionSnapshot = Readonly<{
  materialId: string;
  normativeQuantityMilliUnits: number;
  /** Null until the master records what they actually used. */
  actualQuantityMilliUnits: number | null;
  /** Null when the material had no purchase price when the visit was closed. */
  packagePriceMinor: number | null;
  packageSizeMilliUnits: number | null;
}>;

export type VisitProfitInput = Readonly<{
  currency: Currency;
  lines: readonly VisitLineSnapshot[];
  consumptions: readonly ConsumptionSnapshot[];
  commission: Commission;
  plannedDurationMinutes: number;
  /** Null when the visit was not timed; the planned duration stands in. */
  actualDurationMinutes: number | null;
}>;

export type VisitIncompleteReason =
  | "missing_actual_consumption"
  | "missing_material_price"
  | "no_revenue";

export type MaterialDeviation = Readonly<{
  normativeCostMinor: number | null;
  actualCostMinor: number | null;
  /** Actual minus normative. Positive means more was used than the recipe says. */
  deviationMinor: number | null;
  /** Deviation as a share of the normative cost, in basis points. */
  deviationBasisPoints: number | null;
}>;

export type VisitProfit = Readonly<
  | {
      status: "complete";
      revenueMinor: number;
      /** True when the planned duration stood in, so profit per hour is an estimate. */
      estimatedDuration: boolean;
      durationMinutes: number;
      deviation: MaterialDeviation;
      costing: Extract<CostingResult, { incompleteCostData: false }>;
    }
  | {
      status: "incomplete";
      revenueMinor: number;
      reasons: readonly VisitIncompleteReason[];
      /** Materials whose actual use or price is missing, so the gap can be named. */
      blockingMaterialIds: readonly string[];
      deviation: MaterialDeviation;
    }
>;

function sumCost(
  consumptions: readonly ConsumptionSnapshot[],
  quantityOf: (line: ConsumptionSnapshot) => number | null,
): { total: number | null; blocking: string[] } {
  let total = 0;
  const blocking: string[] = [];

  for (const line of consumptions) {
    const quantity = quantityOf(line);
    if (quantity === null || line.packagePriceMinor === null || line.packageSizeMilliUnits === null) {
      blocking.push(line.materialId);
      continue;
    }
    const cost = materialCostMinor(line.packagePriceMinor, line.packageSizeMilliUnits, quantity);
    if (cost === null) {
      blocking.push(line.materialId);
      continue;
    }
    total += cost;
  }

  return { total: blocking.length > 0 ? null : total, blocking };
}

export function calculateVisitProfit(input: VisitProfitInput): VisitProfit {
  const revenueMinor = input.lines.reduce(
    (total, line) => total + line.priceMinor - line.discountMinor,
    0,
  );

  const normative = sumCost(input.consumptions, (line) => line.normativeQuantityMilliUnits);
  const actual = sumCost(input.consumptions, (line) => line.actualQuantityMilliUnits);

  const deviation: MaterialDeviation = {
    normativeCostMinor: normative.total,
    actualCostMinor: actual.total,
    deviationMinor:
      normative.total === null || actual.total === null ? null : actual.total - normative.total,
    deviationBasisPoints:
      normative.total === null || actual.total === null || normative.total === 0
        ? null
        : roundRatio((actual.total - normative.total) * 10_000, normative.total),
  };

  const reasons: VisitIncompleteReason[] = [];
  if (revenueMinor <= 0) reasons.push("no_revenue");

  if (actual.total === null) {
    // Section 8.8.1: a missing actual consumption is never read as zero. The
    // visit is stored and listed (CST-010), it just carries no margin.
    const missingPrice = input.consumptions.some(
      (line) => line.packagePriceMinor === null || line.packageSizeMilliUnits === null,
    );
    const missingActual = input.consumptions.some((line) => line.actualQuantityMilliUnits === null);
    if (missingActual) reasons.push("missing_actual_consumption");
    if (missingPrice) reasons.push("missing_material_price");
  }

  if (reasons.length > 0 || actual.total === null) {
    return {
      status: "incomplete",
      revenueMinor,
      reasons,
      blockingMaterialIds: actual.blocking,
      deviation,
    };
  }

  // Section 8.8.1: with no actual duration the planned one stands in and the
  // result is an estimate — unlike materials, where a gap blocks the margin.
  const estimatedDuration = input.actualDurationMinutes === null;
  const durationMinutes = input.actualDurationMinutes ?? input.plannedDurationMinutes;

  const costing = calculateCosting({
    priceMinor: revenueMinor,
    materialCostMinor: actual.total,
    durationMinutes,
    currency: input.currency,
    commission: input.commission,
  });

  if (costing.incompleteCostData) {
    return {
      status: "incomplete",
      revenueMinor,
      reasons: ["missing_actual_consumption"],
      blockingMaterialIds: actual.blocking,
      deviation,
    };
  }

  return { status: "complete", revenueMinor, estimatedDuration, durationMinutes, deviation, costing };
}
