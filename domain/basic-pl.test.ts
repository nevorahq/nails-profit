import { describe, expect, it } from "vitest";

import { basicPL } from "@/domain/basic-pl";
import { aggregateVisitMetrics, type VisitMetricRow } from "@/domain/dashboard-metrics";
import { expensesForMonth } from "@/domain/expense-periods";
import { selectLaborRules } from "@/domain/labor-cost";
import { buildPeriodPL } from "@/domain/period-pl";

/*
 * 600 charged at 40%: a hired master takes 240 home, a principal's 240 never
 * leaves. Rent 800, a salary of 500.
 */
function visit(visitId: string, masterIsPrincipal: boolean): VisitMetricRow {
  return {
    visitId,
    serviceId: "service-a",
    serviceName: "Маникюр",
    revenueMinor: 600_00,
    commissionMinor: 240_00,
    contributionMarginMinor: 360_00,
    vatMinor: null,
    turnoverTaxMinor: null,
    payrollTaxMinor: null,
    paymentCommissionMinor: null,
    durationMinutes: 90,
    workedMinutes: 90,
    incompleteReasons: [],
    completedAt: new Date("2026-03-12T10:00:00.000Z"),
    masterIsPrincipal,
  };
}

function month(rows: VisitMetricRow[]) {
  return buildPeriodPL({
    month: "2026-03",
    metrics: aggregateVisitMetrics(rows),
    expenses: expensesForMonth(
      [
        {
          id: "rent",
          name: "Аренда",
          category: "rent",
          amountMinor: 800_00,
          spentOn: "2026-03-05",
          isRecurring: false,
          recurringFrom: null,
          recurringTo: null,
        },
      ],
      "2026-03",
    ),
    laborRules: selectLaborRules(
      [
        {
          id: "salary",
          recipient: "specialist",
          specialistId: "master-a",
          label: "Оклад",
          basis: "fixed_monthly",
          amountMinor: 500_00,
          basisPoints: null,
          payrollTaxBasisPoints: 0,
          activeFrom: new Date("2026-01-01T00:00:00.000Z"),
          activeTo: null,
        },
      ],
      "2026-03",
    ),
  });
}

describe("basicPL", () => {
  it("is the detailed statement itself when nobody working is the owner", () => {
    const pl = month([visit("1", false), visit("2", false)]);

    expect(basicPL(pl)).toEqual({
      paidToMastersMinor: 480_00,
      leftAfterVisitsMinor: 720_00,
      leftForMonthMinor: pl.operatingProfitMinor,
    });
    // Nothing moved: the plain lines are the detailed ones under other names.
    expect(basicPL(pl).leftAfterVisitsMinor).toBe(pl.contributionMarginMinor);
  });

  it("moves a principal's commission out of the costs instead of adding it back", () => {
    const pl = month([visit("1", false), visit("2", true)]);
    const plain = basicPL(pl);

    // Only the hired master's 240 left the business.
    expect(plain.paidToMastersMinor).toBe(240_00);
    expect(plain.leftAfterVisitsMinor).toBe(960_00);
    // The bottom line is the operating profit, to the unit.
    expect(plain.leftForMonthMinor).toBe(pl.operatingProfitMinor);
    expect(pl.operatingProfitMinor).toBe(960_00 - 500_00 - 800_00);
  });

  it("adds up: what the visits leave, less wages and rent, is the month", () => {
    const pl = month([visit("1", true), visit("2", true), visit("3", false)]);
    const plain = basicPL(pl);

    expect(plain.leftAfterVisitsMinor - pl.salariedLabourMinor - pl.overheadMinor).toBe(plain.leftForMonthMinor);
    expect(pl.revenueMinor - plain.paidToMastersMinor).toBe(plain.leftAfterVisitsMinor);
  });

  it("keeps a losing month a losing one", () => {
    const pl = month([visit("1", false)]);

    expect(basicPL(pl).leftForMonthMinor).toBe(360_00 - 500_00 - 800_00);
    expect(basicPL(pl).leftForMonthMinor).toBeLessThan(0);
  });
});
