import { describe, expect, it } from "vitest";

import { calculateVisitProfit, type ConsumptionSnapshot, type VisitProfitInput } from "@/domain/visit-profit";
import { toMilliUnits } from "@/domain/units";

/** 100 MDL for a 10 ml bottle, so 10 MDL per ml — easy to check by eye. */
const gel = (
  overrides: Partial<ConsumptionSnapshot> = {},
): ConsumptionSnapshot => ({
  materialId: "gel",
  normativeQuantityMilliUnits: toMilliUnits(2),
  actualQuantityMilliUnits: toMilliUnits(2),
  packagePriceMinor: 10_000,
  packageSizeMilliUnits: toMilliUnits(10),
  ...overrides,
});

function visit(overrides: Partial<VisitProfitInput> = {}): VisitProfitInput {
  return {
    currency: "MDL",
    lines: [{ kind: "service", priceMinor: 60_000, discountMinor: 0 }],
    consumptions: [gel()],
    commission: { type: "percentage", basisPoints: 4_000 },
    plannedDurationMinutes: 90,
    actualDurationMinutes: 90,
    ...overrides,
  };
}

describe("calculateVisitProfit", () => {
  it("costs a completed visit from its snapshots", () => {
    const result = calculateVisitProfit(visit());

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    // 600 revenue, 20 materials, 240 commission => 340 left.
    expect(result.revenueMinor).toBe(60_000);
    expect(result.costing).toMatchObject({
      materialCostMinor: 2_000,
      commissionMinor: 24_000,
      contributionMarginMinor: 34_000,
    });
  });

  it("sums add-on lines into the revenue", () => {
    const result = calculateVisitProfit(
      visit({
        lines: [
          { kind: "service", priceMinor: 60_000, discountMinor: 0 },
          { kind: "add_on", priceMinor: 10_000, discountMinor: 0 },
        ],
      }),
    );

    expect(result.revenueMinor).toBe(70_000);
  });

  it("subtracts a discount from the revenue the commission is taken on", () => {
    const result = calculateVisitProfit(
      visit({ lines: [{ kind: "service", priceMinor: 60_000, discountMinor: 10_000 }] }),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.revenueMinor).toBe(50_000);
    // The master's 40% is of what the client actually paid, not of the list price.
    expect(result.costing.commissionMinor).toBe(20_000);
  });

  it("reports overspend against the recipe in money and in percent", () => {
    // CST-007: normative 2 ml, actually used 3 ml.
    const result = calculateVisitProfit(
      visit({ consumptions: [gel({ actualQuantityMilliUnits: toMilliUnits(3) })] }),
    );

    expect(result.deviation).toEqual({
      normativeCostMinor: 2_000,
      actualCostMinor: 3_000,
      deviationMinor: 1_000,
      deviationBasisPoints: 5_000,
    });
  });

  it("reports underspend as a negative deviation", () => {
    const result = calculateVisitProfit(
      visit({ consumptions: [gel({ actualQuantityMilliUnits: toMilliUnits(1) })] }),
    );

    expect(result.deviation.deviationMinor).toBe(-1_000);
    expect(result.deviation.deviationBasisPoints).toBe(-5_000);
  });

  it("charges the margin on what was actually used, not on the norm", () => {
    const result = calculateVisitProfit(
      visit({ consumptions: [gel({ actualQuantityMilliUnits: toMilliUnits(5) })] }),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.materialCostMinor).toBe(5_000);
    expect(result.costing.contributionMarginMinor).toBe(31_000);
  });

  it("refuses a margin when an actual consumption was never recorded", () => {
    const result = calculateVisitProfit(
      visit({ consumptions: [gel(), gel({ materialId: "top", actualQuantityMilliUnits: null })] }),
    );

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.reasons).toContain("missing_actual_consumption");
    expect(result.blockingMaterialIds).toEqual(["top"]);
    // Not a partial figure that could be read as the real margin.
    expect(result).not.toHaveProperty("costing");
  });

  it("refuses a margin when a material had no price at closing time", () => {
    const result = calculateVisitProfit(
      visit({ consumptions: [gel({ packagePriceMinor: null, packageSizeMilliUnits: null })] }),
    );

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.reasons).toContain("missing_material_price");
  });

  it("still reports the revenue on an incomplete visit", () => {
    // The owner should see what came in even when the cost side is unfinished.
    const result = calculateVisitProfit(
      visit({ consumptions: [gel({ actualQuantityMilliUnits: null })] }),
    );

    expect(result.revenueMinor).toBe(60_000);
  });

  it("falls back to the planned duration and marks the result an estimate", () => {
    // Section 8.8.1 treats a missing duration differently from a missing
    // material: the planned figure stands in, flagged as an estimate.
    const result = calculateVisitProfit(visit({ actualDurationMinutes: null }));

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.estimatedDuration).toBe(true);
    expect(result.durationMinutes).toBe(90);
    expect(result.costing.profitPerHourMinor).toBe(22_667);
  });

  it("uses the actual duration when it was recorded", () => {
    const result = calculateVisitProfit(visit({ actualDurationMinutes: 120 }));

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.estimatedDuration).toBe(false);
    // The same 340 MDL earned over two hours instead of an hour and a half.
    expect(result.costing.profitPerHourMinor).toBe(17_000);
  });

  it("treats a visit with no revenue as incomplete rather than as a total loss", () => {
    const result = calculateVisitProfit(visit({ lines: [] }));

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.reasons).toContain("no_revenue");
  });

  it("costs a visit that used nothing at all", () => {
    // A consultation with no materials is free of materials, not unknown.
    const result = calculateVisitProfit(visit({ consumptions: [] }));

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.materialCostMinor).toBe(0);
    expect(result.deviation.deviationMinor).toBe(0);
  });

  it("leaves the deviation percentage undefined when the recipe cost nothing", () => {
    const result = calculateVisitProfit(
      visit({ consumptions: [gel({ normativeQuantityMilliUnits: 0, packagePriceMinor: 0 })] }),
    );

    expect(result.deviation.deviationBasisPoints).toBeNull();
  });

  it("reports a loss-making visit as a loss", () => {
    const result = calculateVisitProfit(
      visit({
        lines: [{ kind: "service", priceMinor: 30_000, discountMinor: 0 }],
        consumptions: [gel({ actualQuantityMilliUnits: toMilliUnits(25) })],
      }),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.contributionMarginMinor).toBeLessThan(0);
    expect(result.costing.profitPerHourMinor).toBeLessThan(0);
  });

  it("does not follow a later price change: the snapshot is the price", () => {
    // The same visit costed twice, with the snapshot standing for "the price on
    // the day". Changing the catalogue cannot reach this calculation at all.
    const atVisitTime = calculateVisitProfit(visit());
    const ifPriceHadDoubled = calculateVisitProfit(
      visit({ consumptions: [gel({ packagePriceMinor: 20_000 })] }),
    );

    expect(atVisitTime.status === "complete" && atVisitTime.costing.materialCostMinor).toBe(2_000);
    expect(
      ifPriceHadDoubled.status === "complete" && ifPriceHadDoubled.costing.materialCostMinor,
    ).toBe(4_000);
  });
});
