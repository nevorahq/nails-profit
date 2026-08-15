import {
  calculateCosting,
  type Commission,
  type CommissionBase,
  type CostingResult,
  type TaxRates,
} from "@/domain/costing";
import type { Currency } from "@/domain/money";
import { roundRatio } from "@/domain/money";
import {
  resolveEffectiveMaterialUsage,
  type MaterialUsageSource,
} from "@/domain/material-usage";

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
  /**
   * Given back after the fact. Handled here rather than in
   * `domain/costing.ts`, because a refund is one more term of the same sum the
   * revenue already is — `Σ(price − discount − refund)` — and not a new kind of
   * cost. The engine goes on taking one revenue figure and knowing nothing
   * about how it was arrived at.
   */
  refundMinor?: number;
  /**
   * Whether the master's percentage applies to this line, as decided when the
   * visit closed. Absent reads as true: a rule that names no services covers
   * them all, which is every rule written before this existed.
   */
  commissionable?: boolean;
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
  /** False only for a newly closed service/add-on that has no saved standard profile. */
  standardUsageKnown?: boolean;
  /**
   * What the acquirer charged, and the rates it charged at, as snapshotted into
   * the visit. Absent means cash: no fee, and the visit costs exactly what the
   * same visit cost before any of this existed.
   */
  payment?: Readonly<{ basisPoints: number; fixedFeeMinor: number }>;
  /** The tax rules in force when the visit closed. Absent means none applied. */
  taxes?: TaxRates;
  /**
   * What the master's percentage applies to, as snapshotted into the visit.
   * Absent reads as `after_discount` — what every visit closed before this was
   * costed on.
   */
  commissionBase?: CommissionBase;
}>;

export type VisitIncompleteReason =
  | "missing_actual_consumption"
  | "missing_standard_usage"
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
      materialUsageSource: MaterialUsageSource;
      deviation: MaterialDeviation;
      costing: Extract<CostingResult, { incompleteCostData: false }>;
    }
  | {
      status: "incomplete";
      revenueMinor: number;
      reasons: readonly VisitIncompleteReason[];
      materialUsageSource: MaterialUsageSource;
      /** Materials whose actual use or price is missing, so the gap can be named. */
      blockingMaterialIds: readonly string[];
      deviation: MaterialDeviation;
    }
>;

export function calculateVisitProfit(input: VisitProfitInput): VisitProfit {
  // What the terminal processed: before refunds, because a refund does not
  // return the acquirer's fee. See `PaymentCost.chargedMinor`.
  const chargedMinor = input.lines.reduce(
    (total, line) => total + line.priceMinor - line.discountMinor,
    0,
  );
  const refundedMinor = input.lines.reduce((total, line) => total + (line.refundMinor ?? 0), 0);
  const revenueMinor = chargedMinor - refundedMinor;

  /*
   * What the master's percentage applies to.
   *
   * Two independent questions, answered here because this is where the lines
   * are. Which lines count is a filter the rule set at closing time — «5% but
   * only on colouring». What counts on a line is the base: the sticker price,
   * or what the client actually paid after a discount and a refund. Neither is
   * something the costing engine could work out from the single revenue figure
   * it takes.
   *
   * A rule that names no services and takes the default base produces exactly
   * `revenueMinor`, which is what every visit before this was costed on.
   */
  const commissionable = input.lines.filter((line) => line.commissionable !== false);
  const commissionBaseMinor =
    input.commissionBase === "full_price"
      ? commissionable.reduce((total, line) => total + line.priceMinor, 0)
      : commissionable.reduce(
          (total, line) => total + line.priceMinor - line.discountMinor - (line.refundMinor ?? 0),
          0,
        );

  const usage = resolveEffectiveMaterialUsage(
    input.consumptions.map((line) => ({
      materialId: line.materialId,
      standardQuantityMilliUnits: line.normativeQuantityMilliUnits,
      actualQuantityMilliUnits: line.actualQuantityMilliUnits,
      packagePriceMinor: line.packagePriceMinor,
      packageSizeMilliUnits: line.packageSizeMilliUnits,
    })),
  );

  const deviation: MaterialDeviation = {
    normativeCostMinor: usage.standardTotalMinor,
    // Kept under the established name for API/report compatibility. Under the
    // standard-cost workflow this is the effective cost, not "actual or null".
    actualCostMinor: usage.effectiveTotalMinor,
    deviationMinor:
      usage.standardTotalMinor === null || usage.effectiveTotalMinor === null
        ? null
        : usage.effectiveTotalMinor - usage.standardTotalMinor,
    deviationBasisPoints:
      usage.standardTotalMinor === null ||
      usage.effectiveTotalMinor === null ||
      usage.standardTotalMinor === 0
        ? null
        : roundRatio(
            (usage.effectiveTotalMinor - usage.standardTotalMinor) * 10_000,
            usage.standardTotalMinor,
          ),
  };

  const reasons: VisitIncompleteReason[] = [];
  if (revenueMinor <= 0) reasons.push("no_revenue");

  // A partially known profile is still unknown. For example, a service may
  // have a recipe while one selected add-on does not. Existing recipe rows
  // must not make the missing part look free.
  if (input.standardUsageKnown === false) {
    reasons.push("missing_standard_usage");
  }
  if (usage.effectiveTotalMinor === null) reasons.push("missing_material_price");

  if (reasons.length > 0 || usage.effectiveTotalMinor === null) {
    return {
      status: "incomplete",
      revenueMinor,
      reasons,
      materialUsageSource: usage.source,
      blockingMaterialIds: usage.blockingMaterialIds,
      deviation,
    };
  }

  // Section 8.8.1: with no actual duration the planned one stands in and the
  // result is an estimate — unlike materials, where a gap blocks the margin.
  const estimatedDuration = input.actualDurationMinutes === null;
  const durationMinutes = input.actualDurationMinutes ?? input.plannedDurationMinutes;

  const costing = calculateCosting({
    priceMinor: revenueMinor,
    materialCostMinor: usage.effectiveTotalMinor,
    durationMinutes,
    currency: input.currency,
    commission: input.commission,
    commissionBaseMinor,
    ...(input.payment ? { payment: { ...input.payment, chargedMinor } } : {}),
    ...(input.taxes ? { taxes: input.taxes } : {}),
  });

  if (costing.incompleteCostData) {
    return {
      status: "incomplete",
      revenueMinor,
      reasons: ["missing_material_price"],
      materialUsageSource: usage.source,
      blockingMaterialIds: usage.blockingMaterialIds,
      deviation,
    };
  }

  return {
    status: "complete",
    revenueMinor,
    estimatedDuration,
    durationMinutes,
    materialUsageSource: usage.source,
    deviation,
    costing,
  };
}
