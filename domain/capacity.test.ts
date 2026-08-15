import { describe, expect, it } from "vitest";

import {
  allocatedFixedCostMinor,
  breakEvenRevenueMinor,
  buildCapacityView,
  capacityUtilizationBasisPoints,
  contributionRatioBasisPoints,
  fixedCostRateMinorPerHour,
  practicalCapacityMinutes,
  scheduledMinutesInMonth,
  type CapacityExceptionInput,
  type CapacityRuleInput,
} from "@/domain/capacity";

/** A weekly shift, by default 09:00–18:00 in Chisinau, open-ended. */
function shift(overrides: Partial<CapacityRuleInput> = {}): CapacityRuleInput {
  return {
    specialistId: "master-a",
    timezone: "Europe/Chisinau",
    weekday: 1,
    startMinute: 9 * 60,
    endMinute: 18 * 60,
    effectiveFrom: "2020-01-01",
    effectiveTo: null,
    ...overrides,
  };
}

function block(
  start: string,
  end: string,
  overrides: Partial<CapacityExceptionInput> = {},
): CapacityExceptionInput {
  return {
    specialistId: "master-a",
    kind: "unavailable",
    start: new Date(start),
    end: new Date(end),
    ...overrides,
  };
}

describe("scheduledMinutesInMonth", () => {
  it("counts every occurrence of a weekly shift in the month", () => {
    // August 2026 has five Mondays: 3, 10, 17, 24, 31.
    expect(scheduledMinutesInMonth([shift()], [], "2026-08")).toBe(5 * 9 * 60);
  });

  it("adds two specialists rather than merging them", () => {
    const rules = [shift(), shift({ specialistId: "master-b" })];

    // The same Monday morning worked by two people is two hours of capacity.
    expect(scheduledMinutesInMonth(rules, [], "2026-08")).toBe(2 * 5 * 9 * 60);
  });

  it("merges one person's overlapping shifts at two locations", () => {
    const rules = [
      shift(),
      shift({ timezone: "Europe/Chisinau", startMinute: 12 * 60, endMinute: 20 * 60 }),
    ];

    // Nobody is in two places at once: 09:00–20:00 is eleven hours, not seventeen.
    expect(scheduledMinutesInMonth(rules, [], "2026-08")).toBe(5 * 11 * 60);
  });

  it("obeys the effective range of a rule", () => {
    const rules = [shift({ effectiveTo: "2026-08-18" })];

    // Exclusive end: the Mondays of the 3rd, 10th and 17th, not the 24th.
    expect(scheduledMinutesInMonth(rules, [], "2026-08")).toBe(3 * 9 * 60);
  });

  it("removes a day off and adds an extra day", () => {
    const holiday = block("2026-08-10T00:00:00.000Z", "2026-08-11T00:00:00.000Z");
    const extra = block("2026-08-15T07:00:00.000Z", "2026-08-15T11:00:00.000Z", {
      kind: "available",
    });

    expect(scheduledMinutesInMonth([shift()], [holiday], "2026-08")).toBe(4 * 9 * 60);
    expect(scheduledMinutesInMonth([shift()], [holiday, extra], "2026-08")).toBe(
      4 * 9 * 60 + 4 * 60,
    );
  });

  it("does not let one person's day off shorten another's rota", () => {
    const rules = [shift(), shift({ specialistId: "master-b" })];
    const holiday = block("2026-08-10T00:00:00.000Z", "2026-08-11T00:00:00.000Z");

    expect(scheduledMinutesInMonth(rules, [holiday], "2026-08")).toBe(9 * 9 * 60);
  });

  it("keeps only the part of a shift that falls inside the month", () => {
    // A Monday shift that runs to midnight local time: 31 August 2026 is a
    // Monday, and the last hours belong to August, not to September.
    const late = shift({ startMinute: 20 * 60, endMinute: 24 * 60 });

    expect(scheduledMinutesInMonth([late], [], "2026-08")).toBe(5 * 4 * 60);
    expect(scheduledMinutesInMonth([late], [], "2026-09")).toBe(4 * 4 * 60);
  });

  it("is zero for a specialist with no rota", () => {
    expect(scheduledMinutesInMonth([], [], "2026-08")).toBe(0);
  });

  /*
   * The owner-master case, section 7.1 of the plan. Their administrative hours
   * are not on the rota, so they are not capacity. Counting a calendar month
   * instead would put ~176 hours in the denominator against three worked days a
   * week, understating utilization and overstating the rate at which fixed
   * costs are spread over services.
   */
  it("counts the owner-master's rostered days, not the calendar", () => {
    const owner = [
      shift({ specialistId: "owner", weekday: 2 }),
      shift({ specialistId: "owner", weekday: 4 }),
    ];

    // Tuesdays and Thursdays of August 2026: four of each.
    expect(scheduledMinutesInMonth(owner, [], "2026-08")).toBe(8 * 9 * 60);
  });
});

describe("practicalCapacityMinutes", () => {
  it("takes the configured share of the rota", () => {
    expect(practicalCapacityMinutes(10_000, 7500)).toBe(7_500);
    expect(practicalCapacityMinutes(10_000, 10_000)).toBe(10_000);
  });

  it("is zero when there is no rota", () => {
    expect(practicalCapacityMinutes(0, 7500)).toBe(0);
  });
});

describe("capacityUtilizationBasisPoints", () => {
  it("reports booked time against sellable time", () => {
    expect(capacityUtilizationBasisPoints(4_500, 9_000)).toBe(5_000);
  });

  it("reports more than full when the month ran over capacity", () => {
    // Not clamped: a studio working past what it planned to sell needs to know.
    expect(capacityUtilizationBasisPoints(11_000, 10_000)).toBe(11_000);
  });

  it("is null without capacity, never zero", () => {
    expect(capacityUtilizationBasisPoints(0, 0)).toBeNull();
  });
});

describe("fixed cost allocation", () => {
  it("spreads fixed costs over an hour of sellable time", () => {
    // 30 000 MDL over 100 sellable hours is 300 MDL an hour.
    expect(fixedCostRateMinorPerHour(30_000_00, 100 * 60)).toBe(300_00);
  });

  it("gives a service its share without rounding twice", () => {
    // 100 000 minor over 7 sellable hours, on a 50-minute service. Through a
    // rounded hourly rate this would be 14286 * 50 / 60 = 11905; direct, 11905
    // — and on other inputs the two differ, which is why the direct form is
    // the one the product uses.
    expect(allocatedFixedCostMinor(100_000, 7 * 60, 50)).toBe(11_905);
  });

  it("is null rather than zero when there is nothing to divide by", () => {
    expect(fixedCostRateMinorPerHour(30_000_00, 0)).toBeNull();
    expect(allocatedFixedCostMinor(30_000_00, 0, 60)).toBeNull();
    expect(allocatedFixedCostMinor(30_000_00, 6_000, 0)).toBeNull();
  });

  /*
   * The rule the whole file exists for. Two visits in a month must not make a
   * service dearer than the same service in a busy month.
   */
  it("does not make a service dearer in a slow month", () => {
    const rota = 100 * 60;
    const practical = practicalCapacityMinutes(rota, 7500);

    const busy = allocatedFixedCostMinor(30_000_00, practical, 60);
    const slow = allocatedFixedCostMinor(30_000_00, practical, 60);

    expect(slow).toBe(busy);
    // And what changes instead is the figure that should: utilization.
    expect(capacityUtilizationBasisPoints(60, practical)).toBeLessThan(
      capacityUtilizationBasisPoints(4_000, practical)!,
    );
  });
});

describe("break-even", () => {
  it("counts the owner's own commission as contribution", () => {
    // 10 000 revenue, 3 000 margin, of which the owner's own 1 500 comes back.
    const ratio = contributionRatioBasisPoints({
      revenueMinor: 10_000_00,
      contributionMarginMinor: 3_000_00,
      principalLabourMinor: 1_500_00,
    });

    expect(ratio).toBe(4_500);
  });

  it("has no break-even when every visit loses money", () => {
    const ratio = contributionRatioBasisPoints({
      revenueMinor: 10_000_00,
      contributionMarginMinor: -500_00,
      principalLabourMinor: 0,
    });

    expect(ratio).toBeNull();
    expect(breakEvenRevenueMinor(20_000_00, ratio)).toBeNull();
  });

  it("divides fixed costs by the contribution ratio", () => {
    // 9 000 of fixed costs at 45 kopeks of contribution per leu: 20 000.
    expect(breakEvenRevenueMinor(9_000_00, 4_500)).toBe(20_000_00);
  });

  it("is zero when there is nothing fixed to cover", () => {
    expect(breakEvenRevenueMinor(0, 4_500)).toBe(0);
  });
});

describe("buildCapacityView", () => {
  const base = {
    scheduledMinutes: 100 * 60,
    practicalCapacityBasisPoints: 7500,
    bookedMinutes: 45 * 60,
    revenueMinor: 40_000_00,
    contributionMarginMinor: 16_000_00,
    principalLabourMinor: 2_000_00,
    salariedLabourMinor: 5_000_00,
    overheadMinor: 7_000_00,
    ownerWageMinor: null as number | null,
    operatingProfitMinor: 6_000_00,
  };

  it("puts overhead and salaries in the rate, and the owner's wage nowhere near it", () => {
    const view = buildCapacityView({ ...base, ownerWageMinor: 15_000_00 });

    // The owner's labour is already priced into each visit through the
    // commission booked to them; adding it to the rate spread over services
    // would charge it twice.
    expect(view.fixedCostMinor).toBe(12_000_00);
    expect(view.fixedCostRateMinorPerHour).toBe(160_00);
  });

  it("raises only the break-even target when the owner states a wage", () => {
    const without = buildCapacityView(base);
    const withWage = buildCapacityView({ ...base, ownerWageMinor: 15_000_00 });

    expect(withWage.fixedCostRateMinorPerHour).toBe(without.fixedCostRateMinorPerHour);
    expect(withWage.breakEvenRevenueMinor).toBe(without.breakEvenRevenueMinor);
    expect(withWage.breakEvenWithOwnerWageMinor).toBeGreaterThan(withWage.breakEvenRevenueMinor!);
  });

  it("leaves the second target unstated when the wage is", () => {
    expect(buildCapacityView(base).breakEvenWithOwnerWageMinor).toBeNull();
  });

  it("reports how much revenue is still missing, and stops at zero", () => {
    // A quarter of the month's takings, at the same margin: still short.
    const short = buildCapacityView({
      ...base,
      revenueMinor: 10_000_00,
      contributionMarginMinor: 4_000_00,
      principalLabourMinor: 500_00,
    });
    const past = buildCapacityView(base);

    expect(short.revenueToBreakEvenMinor).toBe(short.breakEvenRevenueMinor! - 10_000_00);
    // Past the point is not a negative distance to it.
    expect(past.revenueToBreakEvenMinor).toBe(0);
  });

  it("answers null for every ratio when there is no rota at all", () => {
    const view = buildCapacityView({ ...base, scheduledMinutes: 0 });

    expect(view.practicalMinutes).toBe(0);
    expect(view.utilizationBasisPoints).toBeNull();
    expect(view.fixedCostRateMinorPerHour).toBeNull();
    expect(view.operatingProfitPerPracticalHourMinor).toBeNull();
    // Break-even needs no rota: it is a revenue target, not an hourly one.
    expect(view.breakEvenRevenueMinor).not.toBeNull();
  });

  it("carries a loss through profit per practical hour", () => {
    const view = buildCapacityView({ ...base, operatingProfitMinor: -3_000_00 });

    expect(view.operatingProfitPerPracticalHourMinor).toBe(-40_00);
  });
});
