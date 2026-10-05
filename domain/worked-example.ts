import { calculateCosting } from "@/domain/costing";
import type { Currency } from "@/domain/money";

/**
 * The one visit every «Подробнее» in the product points at (`/app/how`).
 *
 * A studio visit: a manicure at 600 for an hour and a half, a master on 40%,
 * 35 of materials. The figures are not typed into the page — they come out of
 * `calculateCosting`, the same function every service card and every closed
 * visit is costed by, so the explanation cannot drift from the arithmetic it
 * explains. If the formula changes, this page changes with it, and the test
 * beside this file says by how much.
 *
 * Then the month, which is the same «осталось» summed and less what no single
 * visit pays for: rent, utilities, salaries.
 */
export const WORKED_EXAMPLE = {
  priceMinor: 60_000,
  durationMinutes: 90,
  commissionBasisPoints: 4_000,
  materialsMinor: 3_500,
  visitsPerMonth: 60,
  fixedCostsMinor: 1_200_000,
} as const;

export type WorkedExample = Readonly<{
  priceMinor: number;
  durationMinutes: number;
  commissionBasisPoints: number;
  masterPayMinor: number;
  materialsMinor: number;
  /** What the visit leaves: the price less everything the visit itself costs. */
  leftMinor: number;
  perHourMinor: number;
  visitsPerMonth: number;
  /** The visits of a month, each leaving `leftMinor`. */
  leftAfterVisitsMinor: number;
  fixedCostsMinor: number;
  /** What the month leaves once the costs no visit pays for are out. */
  leftForMonthMinor: number;
}>;

export function workedExample(currency: Currency): WorkedExample {
  const costing = calculateCosting({
    priceMinor: WORKED_EXAMPLE.priceMinor,
    durationMinutes: WORKED_EXAMPLE.durationMinutes,
    currency,
    commission: { type: "percentage", basisPoints: WORKED_EXAMPLE.commissionBasisPoints },
    materialsMinor: WORKED_EXAMPLE.materialsMinor,
  });

  const leftAfterVisitsMinor = costing.contributionMarginMinor * WORKED_EXAMPLE.visitsPerMonth;

  return {
    priceMinor: costing.priceMinor,
    durationMinutes: costing.durationMinutes,
    commissionBasisPoints: WORKED_EXAMPLE.commissionBasisPoints,
    masterPayMinor: costing.commissionMinor,
    materialsMinor: costing.materialsMinor,
    leftMinor: costing.contributionMarginMinor,
    perHourMinor: costing.profitPerHourMinor,
    visitsPerMonth: WORKED_EXAMPLE.visitsPerMonth,
    leftAfterVisitsMinor,
    fixedCostsMinor: WORKED_EXAMPLE.fixedCostsMinor,
    leftForMonthMinor: leftAfterVisitsMinor - WORKED_EXAMPLE.fixedCostsMinor,
  };
}
