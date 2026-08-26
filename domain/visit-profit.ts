import {
  calculateCosting,
  type Commission,
  type CommissionBase,
  type CostingResult,
  type TaxRates,
} from "@/domain/costing";
import type { Currency } from "@/domain/money";

/**
 * Profit of a completed visit, spec section 8.8.1.
 *
 * Everything here is a snapshot taken when the visit was closed. That is the
 * whole point: renaming a service or re-cutting a master's percentage tomorrow
 * must not change what a visit last month earned. The caller passes copies,
 * never references to catalogue rows.
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

export type VisitProfitInput = Readonly<{
  currency: Currency;
  lines: readonly VisitLineSnapshot[];
  commission: Commission;
  plannedDurationMinutes: number;
  /** Null when the visit was not timed; the planned duration stands in. */
  actualDurationMinutes: number | null;
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

/**
 * The one thing that can still stop a visit being costed.
 *
 * The list used to be four long, and the other three were all material gaps —
 * an unpriced material, an unrecorded actual quantity, a service closed before
 * anyone saved what it normally uses. None of them can happen now. This one
 * survives because it is arithmetic, not data: a visit that took no money has
 * no margin to report a percentage of.
 */
export type VisitIncompleteReason = "no_revenue";

export type VisitProfit = Readonly<
  | {
      status: "complete";
      revenueMinor: number;
      /** True when the planned duration stood in, so profit per hour is an estimate. */
      estimatedDuration: boolean;
      durationMinutes: number;
      costing: CostingResult;
    }
  | {
      status: "incomplete";
      revenueMinor: number;
      reasons: readonly VisitIncompleteReason[];
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

  const reasons: VisitIncompleteReason[] = [];
  if (revenueMinor <= 0) reasons.push("no_revenue");

  if (reasons.length > 0) {
    return { status: "incomplete", revenueMinor, reasons };
  }

  // Section 8.8.1: with no actual duration the planned one stands in, and the
  // profit per hour it produces is marked an estimate rather than withheld.
  const estimatedDuration = input.actualDurationMinutes === null;
  const durationMinutes = input.actualDurationMinutes ?? input.plannedDurationMinutes;

  const costing = calculateCosting({
    priceMinor: revenueMinor,
    durationMinutes,
    currency: input.currency,
    commission: input.commission,
    commissionBaseMinor,
    ...(input.payment ? { payment: { ...input.payment, chargedMinor } } : {}),
    ...(input.taxes ? { taxes: input.taxes } : {}),
  });

  return {
    status: "complete",
    revenueMinor,
    estimatedDuration,
    durationMinutes,
    costing,
  };
}
