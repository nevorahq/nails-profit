import {
  applyExceptions,
  workingIntervalsFor,
  type AvailabilityExceptionInput,
  type ScheduleRuleInput,
} from "@/domain/availability";
import { intersectIntervals, mergeIntervals, type Interval } from "@/domain/interval";
import { roundRatio } from "@/domain/money";
import { addLocalDays, compareLocalDates, type LocalDate } from "@/domain/timezone";

/**
 * How much time the studio has to sell, and what follows from it.
 *
 * The one rule this file exists to enforce: **the denominator is practical
 * capacity, never the hours a slow month happened to fill.** Spreading the rent
 * over actual hours makes every service look dearer exactly when custom dries
 * up — the month an owner is deciding whether to cut prices — and the error
 * feeds itself: fewer clients, higher apparent cost, higher prices, fewer
 * clients. Idle time is reported as its own figure instead, where it can be
 * acted on.
 *
 * Practical capacity is a share of *scheduled* hours, not of the calendar. A
 * master rostered three days a week has the capacity of three days; the other
 * four are not idle capacity, they are not capacity at all. This matters most
 * for the owner who also works: their admin hours are not on the rota, so they
 * never enter the denominator, and their utilization is not diluted by the
 * afternoon they spent on the books — see `docs/cost-engine-redesign-plan.md`,
 * section 7.1.
 *
 * Pure: no database, no clock, no locale. Every input is a value.
 */

export type CapacityRuleInput = ScheduleRuleInput &
  Readonly<{
    specialistId: string;
    /** IANA name of the location the shift is worked at. */
    timezone: string;
  }>;

export type CapacityExceptionInput = AvailabilityExceptionInput &
  Readonly<{ specialistId: string }>;

/** `YYYY-MM` → the instants the month opens and closes, the second exclusive. */
function monthInterval(month: string): Interval {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}

function localDateOf(instant: Date): LocalDate {
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  };
}

function minutesIn(intervals: readonly Interval[]): number {
  const total = intervals.reduce(
    (sum, interval) => sum + (interval.end.getTime() - interval.start.getTime()),
    0,
  );
  // Schedules are whole minutes by construction (`start_minute`, `end_minute`),
  // so this rounds nothing away; it converts.
  return Math.round(total / 60_000);
}

/**
 * The minutes the rota puts on offer in a month.
 *
 * Summed per specialist and not merged across them: two masters working the
 * same Tuesday morning are two hours of capacity, not one. Within one
 * specialist the intervals *are* merged, because a person rostered at two
 * locations at once is still one person.
 *
 * Month boundaries are UTC instants, the same ones the visits of the month are
 * filtered by. Capacity and revenue therefore cover the same window, which is
 * the only way a utilization figure means anything.
 */
export function scheduledMinutesInMonth(
  rules: readonly CapacityRuleInput[],
  exceptions: readonly CapacityExceptionInput[],
  month: string,
): number {
  const bounds = monthInterval(month);

  const bySpecialist = new Map<string, CapacityRuleInput[]>();
  for (const rule of rules) {
    bySpecialist.set(rule.specialistId, [...(bySpecialist.get(rule.specialistId) ?? []), rule]);
  }

  let total = 0;

  for (const [specialistId, ownRules] of bySpecialist) {
    const intervals: Interval[] = [];

    // A shift is a local-time pattern, so it is expanded per timezone: a studio
    // with a location in another zone opens by its own clock.
    const byTimezone = new Map<string, CapacityRuleInput[]>();
    for (const rule of ownRules) {
      byTimezone.set(rule.timezone, [...(byTimezone.get(rule.timezone) ?? []), rule]);
    }

    for (const [timezone, zoneRules] of byTimezone) {
      // One local day either side of the month: a shift that starts on the 31st
      // at 22:00 in one zone belongs to the next month's first hours in another,
      // and the clip below is what decides. Walking only the month's own dates
      // would lose those edges.
      let date = localDateOf(new Date(bounds.start.getTime() - 86_400_000));
      const last = localDateOf(new Date(bounds.end.getTime() + 86_400_000));

      while (compareLocalDates(date, last) <= 0) {
        intervals.push(...workingIntervalsFor(zoneRules, date, timezone));
        date = addLocalDays(date, 1);
      }
    }

    const ownExceptions = exceptions.filter((entry) => entry.specialistId === specialistId);
    const afterExceptions = applyExceptions(mergeIntervals(intervals), ownExceptions);

    total += minutesIn(intersectIntervals(afterExceptions, [bounds]));
  }

  return total;
}

/** The sellable share of the rota. */
export function practicalCapacityMinutes(scheduledMinutes: number, basisPoints: number): number {
  if (scheduledMinutes <= 0) return 0;
  return roundRatio(scheduledMinutes * basisPoints, 10_000);
}

/**
 * Booked time over practical capacity, in basis points.
 *
 * Deliberately not capped at 100%: a month that ran past its practical capacity
 * is a real and useful thing to be told, and clamping it would hide the reason
 * the masters are exhausted. Null when there is no capacity to divide by —
 * a studio with no rota has no utilization, and zero would read as idleness.
 */
export function capacityUtilizationBasisPoints(
  bookedMinutes: number,
  practicalMinutes: number,
): number | null {
  if (practicalMinutes <= 0) return null;
  return roundRatio(bookedMinutes * 10_000, practicalMinutes);
}

/** What one sellable hour has to earn before the fixed costs are covered. */
export function fixedCostRateMinorPerHour(
  fixedCostMinor: number,
  practicalMinutes: number,
): number | null {
  if (practicalMinutes <= 0) return null;
  return roundRatio(fixedCostMinor * 60, practicalMinutes);
}

/**
 * One service's share of the month's fixed costs.
 *
 * Computed from the fixed cost and the capacity directly rather than from the
 * hourly rate above, so the rounding happens once. Multiplying a rounded rate
 * by a duration rounds twice, and on a 30-minute service the second rounding is
 * visible.
 */
export function allocatedFixedCostMinor(
  fixedCostMinor: number,
  practicalMinutes: number,
  durationMinutes: number,
): number | null {
  if (practicalMinutes <= 0 || durationMinutes <= 0) return null;
  return roundRatio(fixedCostMinor * durationMinutes, practicalMinutes);
}

/**
 * The share of each unit of revenue that is left to cover fixed costs.
 *
 * Contribution margin **plus** the commission booked to the owner, because that
 * is what the operating profit line adds back: money paid to oneself has not
 * left the business, so it is available to pay the rent. Using the plain margin
 * here would overstate the break-even point for every owner who also works.
 *
 * Null when nothing was earned, and null when the ratio is not positive — a
 * business that loses money on every visit does not break even at some larger
 * volume, it loses more. Returning a huge number there would read as a target.
 */
export function contributionRatioBasisPoints(input: {
  revenueMinor: number;
  contributionMarginMinor: number;
  principalLabourMinor: number;
}): number | null {
  if (input.revenueMinor <= 0) return null;
  const contribution = input.contributionMarginMinor + input.principalLabourMinor;
  if (contribution <= 0) return null;
  return roundRatio(contribution * 10_000, input.revenueMinor);
}

/** The revenue at which fixed costs are exactly covered, at the month's mix. */
export function breakEvenRevenueMinor(
  fixedCostMinor: number,
  contributionBasisPoints: number | null,
): number | null {
  if (contributionBasisPoints === null || contributionBasisPoints <= 0) return null;
  if (fixedCostMinor <= 0) return 0;
  return roundRatio(fixedCostMinor * 10_000, contributionBasisPoints);
}

/**
 * What the capacity numbers say about one month.
 *
 * `fixedCostMinor` is overhead plus salaries and **not** the owner's imputed
 * wage. The owner's own labour is already priced into every visit they work,
 * through the commission booked to them; adding it to the rate that is spread
 * over services as well would charge that labour twice, which invariant 6 of
 * the plan forbids. It appears once more, on its own line, in
 * `breakEvenWithOwnerWageMinor` — where it is added to the *target*, not to the
 * cost of a service.
 */
export type CapacityView = Readonly<{
  scheduledMinutes: number;
  practicalMinutes: number;
  practicalCapacityBasisPoints: number;
  bookedMinutes: number;
  utilizationBasisPoints: number | null;

  fixedCostMinor: number;
  fixedCostRateMinorPerHour: number | null;

  contributionBasisPoints: number | null;
  breakEvenRevenueMinor: number | null;
  /** The same target once the owner's own wage has to be covered too. */
  breakEvenWithOwnerWageMinor: number | null;
  /** Revenue still to earn this month, or zero once the point is passed. */
  revenueToBreakEvenMinor: number | null;

  /** Operating profit over the hours the studio could have sold. */
  operatingProfitPerPracticalHourMinor: number | null;
}>;

export function buildCapacityView(input: {
  scheduledMinutes: number;
  practicalCapacityBasisPoints: number;
  bookedMinutes: number;
  revenueMinor: number;
  contributionMarginMinor: number;
  principalLabourMinor: number;
  salariedLabourMinor: number;
  overheadMinor: number;
  ownerWageMinor: number | null;
  operatingProfitMinor: number;
}): CapacityView {
  const practicalMinutes = practicalCapacityMinutes(
    input.scheduledMinutes,
    input.practicalCapacityBasisPoints,
  );
  const fixedCostMinor = input.overheadMinor + input.salariedLabourMinor;

  const contributionBasisPoints = contributionRatioBasisPoints(input);
  const breakEven = breakEvenRevenueMinor(fixedCostMinor, contributionBasisPoints);

  return {
    scheduledMinutes: input.scheduledMinutes,
    practicalMinutes,
    practicalCapacityBasisPoints: input.practicalCapacityBasisPoints,
    bookedMinutes: input.bookedMinutes,
    utilizationBasisPoints: capacityUtilizationBasisPoints(input.bookedMinutes, practicalMinutes),

    fixedCostMinor,
    fixedCostRateMinorPerHour: fixedCostRateMinorPerHour(fixedCostMinor, practicalMinutes),

    contributionBasisPoints,
    breakEvenRevenueMinor: breakEven,
    breakEvenWithOwnerWageMinor:
      input.ownerWageMinor === null
        ? null
        : breakEvenRevenueMinor(fixedCostMinor + input.ownerWageMinor, contributionBasisPoints),
    revenueToBreakEvenMinor: breakEven === null ? null : Math.max(0, breakEven - input.revenueMinor),

    operatingProfitPerPracticalHourMinor:
      practicalMinutes <= 0 ? null : roundRatio(input.operatingProfitMinor * 60, practicalMinutes),
  };
}
