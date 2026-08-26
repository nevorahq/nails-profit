import type { DashboardMetrics } from "@/domain/dashboard-metrics";
import { laborCostTotals, type LaborCostRuleRow } from "@/domain/labor-cost";
import { roundRatio } from "@/domain/money";
import { byCategory, totalByClass, type ResolvedExpense } from "@/domain/expense-periods";

/**
 * The month's profit and loss.
 *
 * Two levels, and the order of the lines is the argument:
 *
 *   Выручка
 *   − материалы            (потребление по визитам, не закупка)
 *   − оплата труда         (комиссии по снапшотам визитов)
 *   = Contribution Margin
 *   + возврат вменённой оплаты владельца
 *   − оклады наёмных       (месячные, не привязанные к визиту)
 *   − постоянные расходы   (реестр, только класс overhead)
 *   = Операционная прибыль до вознаграждения владельца
 *   − вменённая стоимость труда владельца
 *   = Экономическая прибыль
 *
 * Everything above the margin comes from financial snapshots, so it says what
 * the visits said when they closed and cannot drift when a price changes.
 * Everything below comes from the ledger, and only the half of the ledger that
 * is not already counted above — see `domain/expense-classes.ts`.
 *
 * The add-back is the part that is easy to get wrong. A commission booked to
 * the owner who also works is a real cost of that visit — it is what a hired
 * master would have cost, and without it two services cannot be compared. But
 * the money did not leave the business, so at the level of the month it comes
 * back, and what the owner's own work is worth is stated separately (stage 4).
 * The two lines are shown, never netted: netting them is how a business stops
 * being able to tell profit from wages.
 *
 * Pure: no database, no locale, no formatting. That is what lets every line be
 * a test.
 */

export type PeriodPLInput = Readonly<{
  /** `YYYY-MM`. */
  month: string;
  metrics: DashboardMetrics;
  /** Ledger rows already resolved to this month and narrowed to one currency. */
  expenses: readonly ResolvedExpense[];
  /** Rules already narrowed to this month by `selectLaborRules`. */
  laborRules?: readonly LaborCostRuleRow[];
  /** What the owner keeps back before anything counts as safe to take out. */
  withdrawalReserveMinor?: number;
}>;

export type PeriodPL = Readonly<{
  month: string;

  revenueMinor: number;
  /**
   * What the state and the bank took at the level of the visit. Already inside
   * the contribution margin — they are listed so that the statement on screen
   * adds up, not so that they can be subtracted again.
   */
  vatMinor: number;
  turnoverTaxMinor: number;
  payrollTaxMinor: number;
  paymentCommissionMinor: number;
  labourCostMinor: number;
  contributionMarginMinor: number;

  /** Commission booked to a principal, added back below the margin. */
  principalLabourMinor: number;
  /**
   * Monthly wages owed to hired people, employer's contributions included. A
   * cost of running the place, so it comes out above the operating profit.
   */
  salariedLabourMinor: number;
  overheadMinor: number;
  overheadByCategory: Readonly<Record<string, number>>;
  operatingProfitMinor: number;
  /**
   * Operating profit over the period's whole revenue, in basis points. Null
   * when nothing was earned, where a ratio has no meaning.
   *
   * The denominator is every visit's revenue, not only the costed ones. Pairing
   * a full month of overhead with a partial month of revenue would report a
   * margin higher than the business earned, and of the two directions to be
   * wrong in, this product must not be the one that flatters. Whenever
   * `incompleteVisits` is above zero, the figure is a floor.
   */
  operatingMarginBasisPoints: number | null;

  /**
   * What the owner's own work is worth this month, contributions included.
   *
   * Null until they say — never zero. Zero is the claim that their time is
   * free, and it would turn straight into economic profit that nobody earned.
   * A studio whose owner does not work simply has no rule and no line.
   */
  ownerWageMinor: number | null;
  /**
   * Operating profit less the owner's own wage: what the business made beyond
   * the owner's labour. Null exactly when `ownerWageMinor` is.
   */
  economicProfitMinor: number | null;
  /**
   * Economic profit less the reserve the owner chose to keep in the business,
   * floored at zero — a negative month is not a licence to take money out.
   */
  safeToWithdrawMinor: number | null;

  /** Shown, never subtracted: the same money is already counted above. */
  cashOnlyMinor: number;
  cashOnlyByCategory: Readonly<Record<string, number>>;

  incompleteVisits: number;
  incompleteRevenueMinor: number;
  incompleteReasonCounts: Readonly<Record<string, number>>;
}>;

export function buildPeriodPL(input: PeriodPLInput): PeriodPL {
  const { metrics } = input;

  const overhead = input.expenses.filter((row) => row.class === "overhead");
  const cashOnly = input.expenses.filter((row) => row.class === "cash_only");
  const totals = totalByClass(input.expenses);

  const labour = laborCostTotals(input.laborRules ?? [], { revenueMinor: metrics.revenueMinor });

  const operatingProfitMinor =
    metrics.contributionMarginMinor +
    metrics.principalLabourMinor -
    labour.salariedMinor -
    totals.overhead;

  /*
   * The two lines that must never be netted.
   *
   * A commission booked to the owner is added back above, because the money
   * stayed in the business; what their work is worth is subtracted here,
   * because it is a real cost even though nobody was paid it. Set the wage
   * equal to the commissions and the two cancel exactly — that identity is the
   * anchor the integration test checks. Net them in code instead, and the
   * business loses the ability to tell profit from wages.
   */
  const economicProfitMinor =
    labour.ownerMinor === null ? null : operatingProfitMinor - labour.ownerMinor;

  return {
    month: input.month,

    revenueMinor: metrics.revenueMinor,
    vatMinor: metrics.vatMinor,
    turnoverTaxMinor: metrics.turnoverTaxMinor,
    payrollTaxMinor: metrics.payrollTaxMinor,
    paymentCommissionMinor: metrics.paymentCommissionMinor,
    labourCostMinor: metrics.labourCostMinor,
    contributionMarginMinor: metrics.contributionMarginMinor,

    principalLabourMinor: metrics.principalLabourMinor,
    salariedLabourMinor: labour.salariedMinor,
    overheadMinor: totals.overhead,
    overheadByCategory: byCategory(overhead),
    operatingProfitMinor,
    operatingMarginBasisPoints:
      metrics.revenueMinor === 0
        ? null
        : roundRatio(operatingProfitMinor * 10_000, metrics.revenueMinor),

    ownerWageMinor: labour.ownerMinor,
    economicProfitMinor,
    safeToWithdrawMinor:
      economicProfitMinor === null
        ? null
        : Math.max(0, economicProfitMinor - (input.withdrawalReserveMinor ?? 0)),

    cashOnlyMinor: totals.cash_only,
    cashOnlyByCategory: byCategory(cashOnly),

    incompleteVisits: metrics.incompleteVisits,
    incompleteRevenueMinor: metrics.incompleteRevenueMinor,
    incompleteReasonCounts: metrics.incompleteReasonCounts,
  };
}
