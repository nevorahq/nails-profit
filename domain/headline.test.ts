import { describe, expect, it } from "vitest";

import type { CapacityView } from "@/domain/capacity";
import { aggregateVisitMetrics, type VisitMetricRow } from "@/domain/dashboard-metrics";
import { headlineKindFor, ownerHeadline, visitsHeadline } from "@/domain/headline";
import type { ResolvedExpense } from "@/domain/expense-periods";
import { buildPeriodPL } from "@/domain/period-pl";

function rent(amountMinor: number): ResolvedExpense {
  return {
    id: crypto.randomUUID(),
    name: "Аренда",
    category: "rent",
    amountMinor,
    spentOn: "2026-10-01",
    isRecurring: false,
    recurringFrom: null,
    recurringTo: null,
    month: "2026-10",
    class: "overhead",
  };
}

function row(overrides: Partial<VisitMetricRow>): VisitMetricRow {
  return {
    visitId: crypto.randomUUID(),
    serviceId: "manicure",
    serviceName: "Маникюр",
    revenueMinor: 50_000,
    commissionMinor: 20_000,
    contributionMarginMinor: 30_000,
    durationMinutes: 60,
    workedMinutes: 60,
    vatMinor: 0,
    turnoverTaxMinor: 0,
    payrollTaxMinor: 0,
    paymentCommissionMinor: 0,
    incompleteReasons: [],
    masterIsPrincipal: false,
    completedAt: new Date("2026-10-02T10:00:00Z"),
    ...overrides,
  };
}

function capacity(overrides: Partial<CapacityView>): CapacityView {
  return {
    breakEvenRevenueMinor: null,
    revenueToBreakEvenMinor: null,
    ...overrides,
  } as CapacityView;
}

describe("which figure a role opens on", () => {
  it("gives the owner the operating profit, the master their earnings and the rest the margin", () => {
    expect(headlineKindFor("owner")).toBe("operating");
    expect(headlineKindFor("master")).toBe("earnings");
    expect(headlineKindFor("manager")).toBe("contribution");
    expect(headlineKindFor("analyst")).toBe("contribution");
  });
});

describe("the owner's card", () => {
  const metrics = aggregateVisitMetrics([row({}), row({})]);
  const pl = buildPeriodPL({
    month: "2026-10",
    metrics,
    expenses: [rent(40_000)],
  });

  it("is the P&L's operating profit, split into what came in and what went out", () => {
    const headline = ownerHeadline(pl, capacity({}));
    expect(pl.operatingProfitMinor).toBe(20_000);
    expect(headline).toMatchObject({
      kind: "operating",
      amountMinor: 20_000,
      revenueMinor: 100_000,
      costsMinor: 80_000,
      breakEven: null,
      floor: null,
    });
  });

  it("stays a loss when the month is one", () => {
    const losing = buildPeriodPL({
      month: "2026-10",
      metrics,
      expenses: [rent(75_000)],
    });
    const headline = ownerHeadline(losing, capacity({}));
    expect(headline.amountMinor).toBe(-15_000);
    expect(headline).toMatchObject({ revenueMinor: 100_000, costsMinor: 115_000 });
  });

  it("leaves visits still to be costed out of «выручка − расходы» and names them as a floor", () => {
    const partial = buildPeriodPL({
      month: "2026-10",
      metrics: aggregateVisitMetrics([
        row({}),
        row({
          revenueMinor: 70_000,
          commissionMinor: null,
          contributionMarginMinor: null,
          incompleteReasons: ["MISSING_COMMISSION_RULE"],
        }),
      ]),
      expenses: [],
    });
    const headline = ownerHeadline(partial, capacity({}));
    expect(partial.revenueMinor).toBe(120_000);
    expect(headline).toMatchObject({
      amountMinor: 30_000,
      revenueMinor: 50_000,
      costsMinor: 20_000,
      floor: { visits: 1, revenueMinor: 70_000 },
    });
  });

  it("measures the way to break-even against the month's whole revenue", () => {
    const halfway = ownerHeadline(pl, capacity({ breakEvenRevenueMinor: 200_000, revenueToBreakEvenMinor: 100_000 }));
    expect(halfway.kind === "operating" && halfway.breakEven).toEqual({
      targetMinor: 200_000,
      toGoMinor: 100_000,
      progressBasisPoints: 5_000,
    });
  });

  it("caps the bar once the month is past break-even", () => {
    const past = ownerHeadline(pl, capacity({ breakEvenRevenueMinor: 80_000, revenueToBreakEvenMinor: 0 }));
    expect(past.kind === "operating" && past.breakEven).toEqual({
      targetMinor: 80_000,
      toGoMinor: 0,
      progressBasisPoints: 10_000,
    });
  });

  it("counts a month with nothing fixed to cover as already past it", () => {
    const nothingFixed = ownerHeadline(pl, capacity({ breakEvenRevenueMinor: 0, revenueToBreakEvenMinor: 0 }));
    expect(nothingFixed.kind === "operating" && nothingFixed.breakEven).toEqual({
      targetMinor: 0,
      toGoMinor: 0,
      progressBasisPoints: 10_000,
    });
  });

  it("treats a missing distance as none left", () => {
    const unknown = ownerHeadline(pl, capacity({ breakEvenRevenueMinor: 150_000, revenueToBreakEvenMinor: null }));
    expect(unknown.kind === "operating" && unknown.breakEven).toMatchObject({ toGoMinor: 0 });
  });
});

describe("everyone else's card", () => {
  const metrics = aggregateVisitMetrics([
    row({}),
    row({
      revenueMinor: 30_000,
      commissionMinor: null,
      contributionMarginMinor: null,
      incompleteReasons: ["MISSING_COMMISSION_RULE"],
    }),
  ]);

  it("is a master's commission on their own visits", () => {
    expect(visitsHeadline("earnings", metrics)).toEqual({
      kind: "earnings",
      amountMinor: 20_000,
      floor: { visits: 1, revenueMinor: 30_000 },
    });
  });

  it("is the takings for a master renting a chair, not their 0% commission", () => {
    const rented = row({ masterCooperation: "rent", commissionMinor: 0, contributionMarginMinor: 50_000 });
    expect(visitsHeadline("earnings", aggregateVisitMetrics([rented, { ...rented, visitId: "b" }]))).toEqual({
      kind: "takings",
      amountMinor: 100_000,
      floor: null,
    });
  });

  it("counts the takings even of a rented visit that could not be costed", () => {
    const uncosted = row({
      masterCooperation: "rent",
      commissionMinor: null,
      contributionMarginMinor: null,
      incompleteReasons: ["MISSING_DURATION"],
    });
    expect(visitsHeadline("earnings", aggregateVisitMetrics([uncosted]))).toMatchObject({
      kind: "takings",
      amountMinor: 50_000,
      floor: null,
    });
  });

  it("adds a month that changed halfway visit by visit, and calls it earnings", () => {
    const before = row({ masterCooperation: "commission" });
    const after = row({ masterCooperation: "rent", commissionMinor: 0 });
    expect(visitsHeadline("earnings", aggregateVisitMetrics([before, after]))).toEqual({
      kind: "earnings",
      amountMinor: 20_000 + 50_000,
      floor: null,
    });
  });

  it("names an empty month by the card, since no visit can", () => {
    const empty = aggregateVisitMetrics([]);
    expect(visitsHeadline("earnings", empty, { rentsChair: true })).toEqual({ kind: "takings", amountMinor: 0, floor: null });
    expect(visitsHeadline("earnings", empty, { rentsChair: false }).kind).toBe("earnings");
    expect(visitsHeadline("earnings", empty).kind).toBe("earnings");
  });

  it("is the margin before rent for a role that cannot see the rent", () => {
    expect(visitsHeadline("contribution", aggregateVisitMetrics([row({}), row({ contributionMarginMinor: -5_000 })]))).toEqual({
      kind: "contribution",
      amountMinor: 25_000,
      floor: null,
    });
  });
});
