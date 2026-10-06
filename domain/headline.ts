import type { CapacityView } from "@/domain/capacity";
import type { DashboardMetrics } from "@/domain/dashboard-metrics";
import { roundRatio } from "@/domain/money";
import type { PeriodPL } from "@/domain/period-pl";
import { can, scopeFor, type MemberRole } from "@/domain/rbac";

/**
 * The one figure the report opens with, and which figure that is for whom.
 *
 * Nothing here computes money. Each kind is a line some other module already
 * owns — the operating profit of `buildPeriodPL`, the commission and the
 * contribution margin of `aggregateVisitMetrics` — and is only picked out and
 * named. That is the whole guarantee that the card and the monthly report agree:
 * there is no second formula for them to disagree with.
 *
 * Which line a role gets is decided by what it may read, through the capability
 * matrix rather than by naming roles:
 *
 * - whoever may read the ledger gets what is left after it — the operating
 *   profit, the bottom line of «Месяц подробно»;
 * - whoever is limited to their own rows gets what they earned on them — and a
 *   master renting a chair, what their clients paid them;
 * - anyone else sees every visit but not the rent, so gets the margin above
 *   the rent, and the card says so.
 */

export type HeadlineKind = "operating" | "earnings" | "takings" | "contribution";

/**
 * The kind a role is owed. «takings» is never a role's: it is what «earnings»
 * becomes for a master renting a chair, decided from their visits.
 */
export function headlineKindFor(role: MemberRole): Exclude<HeadlineKind, "takings"> {
  if (can(role, "expenses", "read")) return "operating";
  if (scopeFor(role, "dashboard") === "own") return "earnings";
  return "contribution";
}

/**
 * Visits with no costing yet. Their revenue is in no margin, so whatever the
 * card shows is a floor — «не меньше» — and the card says how much is missing.
 */
export type HeadlineFloor = Readonly<{ visits: number; revenueMinor: number }> | null;

export type BreakEvenProgress = Readonly<{
  targetMinor: number;
  /** Revenue to go before the month stops losing money; zero once it has. */
  toGoMinor: number;
  /** How far along, in basis points, capped at 100 %. */
  progressBasisPoints: number;
}>;

export type Headline =
  | Readonly<{
      kind: "operating";
      amountMinor: number;
      /**
       * The two halves of the one line under the figure, «выручка − расходы».
       * Revenue of the costed visits only: the visits still to be costed are in
       * the floor note instead, and counting their revenue here would make
       * their missing costs read as zero.
       */
      revenueMinor: number;
      costsMinor: number;
      breakEven: BreakEvenProgress | null;
      floor: HeadlineFloor;
    }>
  | Readonly<{ kind: "earnings" | "takings" | "contribution"; amountMinor: number; floor: HeadlineFloor }>;

function floorOf(incompleteVisits: number, incompleteRevenueMinor: number): HeadlineFloor {
  return incompleteVisits > 0 ? { visits: incompleteVisits, revenueMinor: incompleteRevenueMinor } : null;
}

/** The owner's card: the month's P&L, and how far it is past break-even. */
export function ownerHeadline(pl: PeriodPL, capacity: CapacityView): Headline {
  const costedRevenueMinor = pl.revenueMinor - pl.incompleteRevenueMinor;
  const target = capacity.breakEvenRevenueMinor;

  return {
    kind: "operating",
    amountMinor: pl.operatingProfitMinor,
    revenueMinor: costedRevenueMinor,
    costsMinor: costedRevenueMinor - pl.operatingProfitMinor,
    /*
     * The same comparison «Месяц подробно» prints as «осталось заработать»:
     * the visits' revenue against the target — what the visits still have to
     * earn once the chairs' rent has paid its part. Null when there is no
     * target — no margin to cover the rent with — and the bar would be a
     * promise that more visits help.
     */
    breakEven:
      target === null
        ? null
        : {
            targetMinor: target,
            toGoMinor: capacity.revenueToBreakEvenMinor ?? 0,
            progressBasisPoints:
              target === 0 ? 10_000 : Math.min(10_000, Math.max(0, roundRatio(pl.visitRevenueMinor * 10_000, target))),
          },
    floor: floorOf(pl.incompleteVisits, pl.incompleteRevenueMinor),
  };
}

/**
 * Everyone else's card, from the visits alone.
 *
 * `metrics` must already be narrowed to what the role may see: a master's own
 * visits, or the whole studio for a manager and an analyst. This function
 * reads lines; it does not decide scope.
 */
export function visitsHeadline(
  kind: "earnings" | "contribution",
  metrics: DashboardMetrics,
  /** Whether the reader's own card rents a chair today — said only for `earnings`. */
  options: Readonly<{ rentsChair?: boolean }> = {},
): Headline {
  if (kind === "contribution") {
    return {
      kind,
      amountMinor: metrics.contributionMarginMinor,
      floor: floorOf(metrics.incompleteVisits, metrics.incompleteRevenueMinor),
    };
  }

  /*
   * A master renting a chair is not paid a share of their visits: the clients
   * pay them, and they pay the studio its rent. So what they earned on a
   * rented visit is its takings, and their 0% commission would read as a month
   * of work for nothing. Visit by visit, by the cooperation snapshotted on it,
   * so a month that changed halfway counts each half as it was.
   */
  const amountMinor = metrics.labourCostMinor - metrics.rentedLabourMinor + metrics.rentedRevenueMinor;
  const allRented = metrics.visits > 0 ? metrics.rentedVisits === metrics.visits : options.rentsChair === true;
  if (allRented) {
    // Takings need no costing, so nothing is missing from them.
    return { kind: "takings", amountMinor, floor: null };
  }
  return {
    kind: "earnings",
    amountMinor,
    floor: floorOf(metrics.incompleteVisits, metrics.incompleteRevenueMinor),
  };
}
