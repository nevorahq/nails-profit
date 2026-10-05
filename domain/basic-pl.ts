import type { PeriodPL } from "@/domain/period-pl";

/**
 * The month's P&L as the plain view prints it: what came in, what went out,
 * what is left.
 *
 * The detailed statement books a principal's commission as a cost of the visit
 * and adds it back under the margin — two lines that must not be netted there,
 * because that is what lets an owner tell profit from wages. The plain view
 * draws neither line, so it has to net them here or its table stops adding up:
 * the work paid for becomes only the work somebody else was paid for, and what
 * the visits leave grows by the same amount.
 *
 * Nothing is recomputed. The bottom line is `operatingProfitMinor` itself, and
 * the two lines above it are the detailed ones with the add-back moved across;
 * every difference between the views is a principal's commission.
 */
export type BasicPL = Readonly<{
  /** Commission that left the business: everybody's but a principal's. */
  paidToMastersMinor: number;
  /** Revenue less what the visits cost in money that actually left. */
  leftAfterVisitsMinor: number;
  /** The month's bottom line — the operating profit, under its plain name. */
  leftForMonthMinor: number;
}>;

export function basicPL(pl: PeriodPL): BasicPL {
  return {
    paidToMastersMinor: pl.labourCostMinor - pl.principalLabourMinor,
    leftAfterVisitsMinor: pl.contributionMarginMinor + pl.principalLabourMinor,
    leftForMonthMinor: pl.operatingProfitMinor,
  };
}
