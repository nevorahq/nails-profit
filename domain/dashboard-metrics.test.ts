import { describe, expect, it } from "vitest";

import { aggregateVisitMetrics, buildProfitTrend, type VisitMetricRow } from "@/domain/dashboard-metrics";

function row(overrides: Partial<VisitMetricRow> & { visitId: string }): VisitMetricRow {
  return {
    serviceId: "service-a",
    serviceName: "Маникюр",
    revenueMinor: 60_000,
    commissionMinor: null,
    contributionMarginMinor: 34_000,
    materialCostMinor: 2_000,
    normativeMaterialCostMinor: 2_000,
    vatMinor: null,
    turnoverTaxMinor: null,
    payrollTaxMinor: null,
    paymentCommissionMinor: null,
    durationMinutes: 90,
    workedMinutes: 90,
    incompleteReasons: [],
    completedAt: new Date("2026-05-12T10:00:00.000Z"),
    masterIsPrincipal: false,
    ...overrides,
  };
}

describe("aggregateVisitMetrics", () => {
  it("sums revenue and margin over the period", () => {
    const metrics = aggregateVisitMetrics([row({ visitId: "1" }), row({ visitId: "2" })]);

    expect(metrics.visits).toBe(2);
    expect(metrics.revenueMinor).toBe(120_000);
    expect(metrics.contributionMarginMinor).toBe(68_000);
  });

  it("weighs margin by money, not by visit count", () => {
    // Section 8.9.1 defines average margin as total margin over total revenue.
    // A 20 MDL visit at 90% must not offset a 600 MDL one at 10%.
    const metrics = aggregateVisitMetrics([
      row({ visitId: "small", revenueMinor: 2_000, contributionMarginMinor: 1_800 }),
      row({ visitId: "large", revenueMinor: 60_000, contributionMarginMinor: 6_000 }),
    ]);

    // 7800 / 62000 = 12.58%, not the 50% a mean of 90% and 10% would give.
    expect(metrics.marginBasisPoints).toBe(1_258);
  });

  it("divides margin by hours actually worked", () => {
    const metrics = aggregateVisitMetrics([
      row({ visitId: "1", contributionMarginMinor: 30_000, durationMinutes: 60 }),
      row({ visitId: "2", contributionMarginMinor: 30_000, durationMinutes: 120 }),
    ]);

    // 600 MDL over three hours.
    expect(metrics.profitPerHourMinor).toBe(20_000);
  });

  it("keeps uncosted revenue out of the margin denominator", () => {
    // The trap this guards against: dividing all revenue into the margin of the
    // costed visits only would understate the margin and look like a real drop.
    const metrics = aggregateVisitMetrics([
      row({ visitId: "costed" }),
      row({
        visitId: "uncosted",
        contributionMarginMinor: null,
        materialCostMinor: null,
        durationMinutes: null,
        incompleteReasons: ["missing_actual_consumption"],
      }),
    ]);

    expect(metrics.revenueMinor).toBe(120_000);
    expect(metrics.costedRevenueMinor).toBe(60_000);
    // 34000 / 60000, not 34000 / 120000.
    expect(metrics.marginBasisPoints).toBe(5_667);
    expect(metrics.incompleteVisits).toBe(1);
    expect(metrics.incompleteRevenueMinor).toBe(60_000);
  });

  it("counts why the uncosted visits could not be costed", () => {
    const metrics = aggregateVisitMetrics([
      row({ visitId: "a", contributionMarginMinor: null, incompleteReasons: ["missing_actual_consumption"] }),
      row({ visitId: "b", contributionMarginMinor: null, incompleteReasons: ["missing_actual_consumption"] }),
      row({ visitId: "c", contributionMarginMinor: null, incompleteReasons: ["missing_material_price"] }),
    ]);

    expect(metrics.incompleteReasonCounts).toEqual({
      missing_actual_consumption: 2,
      missing_material_price: 1,
    });
  });

  it("compares what the recipes said with what was used", () => {
    const metrics = aggregateVisitMetrics([
      row({ visitId: "1", normativeMaterialCostMinor: 2_000, materialCostMinor: 3_000 }),
      row({ visitId: "2", normativeMaterialCostMinor: 2_000, materialCostMinor: 1_500 }),
    ]);

    expect(metrics.normativeMaterialCostMinor).toBe(4_000);
    expect(metrics.actualMaterialCostMinor).toBe(4_500);
    expect(metrics.materialDeviationMinor).toBe(500);
  });

  it("ranks services by margin and reports profit per hour beside it", () => {
    const metrics = aggregateVisitMetrics([
      row({
        visitId: "long",
        serviceId: "long",
        serviceName: "Наращивание",
        revenueMinor: 100_000,
        contributionMarginMinor: 50_000,
        durationMinutes: 180,
      }),
      row({
        visitId: "quick",
        serviceId: "quick",
        serviceName: "Экспресс",
        revenueMinor: 30_000,
        contributionMarginMinor: 20_000,
        durationMinutes: 30,
      }),
    ]);

    // Ranked by margin, so the long service leads...
    expect(metrics.ranking.map((entry) => entry.serviceName)).toEqual(["Наращивание", "Экспресс"]);
    // ...while per hour the quick one earns twice as much. Seeing both is the
    // decision the product exists to support.
    expect(metrics.ranking[0].profitPerHourMinor).toBe(16_667);
    expect(metrics.ranking[1].profitPerHourMinor).toBe(40_000);
  });

  it("groups repeat visits of the same service together", () => {
    const metrics = aggregateVisitMetrics([
      row({ visitId: "1" }),
      row({ visitId: "2" }),
      row({ visitId: "3", serviceId: "other", serviceName: "Педикюр" }),
    ]);

    expect(metrics.ranking).toHaveLength(2);
    expect(metrics.ranking[0]).toMatchObject({ serviceName: "Маникюр", visits: 2, contributionMarginMinor: 68_000 });
  });

  it("keeps a loss-making service in the ranking, at the bottom", () => {
    const metrics = aggregateVisitMetrics([
      row({ visitId: "good" }),
      row({ visitId: "bad", serviceId: "bad", serviceName: "Убыточная", contributionMarginMinor: -5_000 }),
    ]);

    expect(metrics.ranking.at(-1)).toMatchObject({ serviceName: "Убыточная" });
    expect(metrics.ranking.at(-1)!.contributionMarginMinor).toBeLessThan(0);
  });

  it("reports nothing rather than zero for an empty period", () => {
    const metrics = aggregateVisitMetrics([]);

    expect(metrics.visits).toBe(0);
    expect(metrics.revenueMinor).toBe(0);
    // No visits is not a 0% margin; there is no margin to speak of.
    expect(metrics.marginBasisPoints).toBeNull();
    expect(metrics.profitPerHourMinor).toBeNull();
    expect(metrics.ranking).toEqual([]);
  });

  it("reports no profit per hour when nothing was timed", () => {
    const metrics = aggregateVisitMetrics([row({ visitId: "1", durationMinutes: 0 })]);
    expect(metrics.profitPerHourMinor).toBeNull();
  });
});

describe("buildProfitTrend", () => {
  it("buckets a short period by day", () => {
    const trend = buildProfitTrend([
      row({ visitId: "1", completedAt: new Date("2026-05-12T09:00:00.000Z"), contributionMarginMinor: 10_000 }),
      row({ visitId: "2", completedAt: new Date("2026-05-12T18:00:00.000Z"), contributionMarginMinor: 5_000 }),
      row({ visitId: "3", completedAt: new Date("2026-05-13T09:00:00.000Z"), contributionMarginMinor: 7_000 }),
    ]);

    expect(trend.granularity).toBe("day");
    expect(trend.points).toEqual([
      { key: "2026-05-12", profitMinor: 15_000 },
      { key: "2026-05-13", profitMinor: 7_000 },
    ]);
  });

  it("buckets a period longer than a month by month", () => {
    const trend = buildProfitTrend([
      row({ visitId: "1", completedAt: new Date("2026-01-05T09:00:00.000Z"), contributionMarginMinor: 10_000 }),
      row({ visitId: "2", completedAt: new Date("2026-01-28T09:00:00.000Z"), contributionMarginMinor: 5_000 }),
      row({ visitId: "3", completedAt: new Date("2026-03-02T09:00:00.000Z"), contributionMarginMinor: 7_000 }),
    ]);

    expect(trend.granularity).toBe("month");
    expect(trend.points).toEqual([
      { key: "2026-01", profitMinor: 15_000 },
      { key: "2026-03", profitMinor: 7_000 },
    ]);
  });

  it("leaves out visits that could not be costed", () => {
    const trend = buildProfitTrend([
      row({ visitId: "1", contributionMarginMinor: null }),
    ]);

    expect(trend.points).toEqual([]);
  });

  it("reports nothing rather than zero for an empty period", () => {
    expect(buildProfitTrend([])).toEqual({ granularity: "day", points: [] });
  });
});
