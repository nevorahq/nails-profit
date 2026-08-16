import { describe, expect, it } from "vitest";

import {
  averageUsagePerVisitMilliUnits,
  calibrationSuggestion,
  estimateStock,
  LOW_STOCK_SERVICE_THRESHOLD,
  purchaseAverages,
  remainingServices,
  stockStatus,
} from "@/domain/material-stock";
import { toMilliUnits } from "@/domain/units";

const at = (day: number) => new Date(Date.UTC(2026, 7, day));

describe("estimateStock", () => {
  it("knows nothing about a material that was never bought or counted", () => {
    const balance = estimateStock({ purchases: [], consumptions: [], checks: [] });

    expect(balance.milliUnits).toBeNull();
    expect(balance.basis).toBe("unknown");
  });

  it("adds purchases and subtracts what visits consumed", () => {
    const balance = estimateStock({
      purchases: [{ at: at(1), quantityMilliUnits: toMilliUnits(15) }],
      consumptions: [
        { at: at(2), quantityMilliUnits: toMilliUnits(0.3) },
        { at: at(3), quantityMilliUnits: toMilliUnits(0.3) },
      ],
      checks: [],
      asOf: at(10),
    });

    expect(balance.milliUnits).toBe(toMilliUnits(14.4));
    expect(balance.basis).toBe("purchases");
  });

  it("treats a stock check as the baseline and ignores everything before it", () => {
    const balance = estimateStock({
      purchases: [{ at: at(1), quantityMilliUnits: toMilliUnits(15) }],
      consumptions: [
        { at: at(2), quantityMilliUnits: toMilliUnits(5) },
        { at: at(6), quantityMilliUnits: toMilliUnits(1) },
      ],
      checks: [{ at: at(5), observedQuantityMilliUnits: toMilliUnits(4) }],
      asOf: at(10),
    });

    // 4 counted on the 5th, minus the 1 used on the 6th. The 15 bought and the
    // 5 used before the count are already inside the number that was counted.
    expect(balance.milliUnits).toBe(toMilliUnits(3));
    expect(balance.basis).toBe("check");
    expect(balance.baselineAt).toEqual(at(5));
    expect(balance.consumedSinceMilliUnits).toBe(toMilliUnits(1));
  });

  it("takes the newest check when several exist", () => {
    const balance = estimateStock({
      purchases: [],
      consumptions: [],
      checks: [
        { at: at(2), observedQuantityMilliUnits: toMilliUnits(9) },
        { at: at(7), observedQuantityMilliUnits: toMilliUnits(2) },
      ],
      asOf: at(10),
    });

    expect(balance.milliUnits).toBe(toMilliUnits(2));
  });

  it("counts a purchase made in the same breath as the count only once", () => {
    const balance = estimateStock({
      purchases: [{ at: at(5), quantityMilliUnits: toMilliUnits(15) }],
      consumptions: [],
      checks: [{ at: at(5), observedQuantityMilliUnits: toMilliUnits(15) }],
      asOf: at(10),
    });

    expect(balance.milliUnits).toBe(toMilliUnits(15));
  });

  it("ignores everything after the date asked about", () => {
    const balance = estimateStock({
      purchases: [{ at: at(1), quantityMilliUnits: toMilliUnits(15) }],
      consumptions: [{ at: at(9), quantityMilliUnits: toMilliUnits(3) }],
      checks: [],
      asOf: at(5),
    });

    expect(balance.milliUnits).toBe(toMilliUnits(15));
  });

  it("reports a negative balance rather than hiding it", () => {
    const balance = estimateStock({
      purchases: [{ at: at(1), quantityMilliUnits: toMilliUnits(1) }],
      consumptions: [{ at: at(2), quantityMilliUnits: toMilliUnits(3) }],
      checks: [],
      asOf: at(10),
    });

    expect(balance.milliUnits).toBe(-toMilliUnits(2));
  });
});

describe("remainingServices", () => {
  it("restates the balance in procedures", () => {
    expect(remainingServices(toMilliUnits(5.4), toMilliUnits(0.3))).toBe(18);
  });

  it("rounds down: a part of a procedure is not a procedure", () => {
    expect(remainingServices(toMilliUnits(1), toMilliUnits(0.3))).toBe(3);
  });

  it("has no answer without a balance or without a usage figure", () => {
    expect(remainingServices(null, toMilliUnits(0.3))).toBeNull();
    expect(remainingServices(toMilliUnits(5), null)).toBeNull();
    expect(remainingServices(toMilliUnits(5), 0)).toBeNull();
  });
});

describe("averageUsagePerVisitMilliUnits", () => {
  it("averages what the visits actually used", () => {
    const average = averageUsagePerVisitMilliUnits([
      { at: at(1), quantityMilliUnits: toMilliUnits(0.2) },
      { at: at(2), quantityMilliUnits: toMilliUnits(0.4) },
    ]);

    expect(average).toBe(toMilliUnits(0.3));
  });

  it("has no answer before the first visit", () => {
    expect(averageUsagePerVisitMilliUnits([])).toBeNull();
  });
});

describe("stockStatus", () => {
  it("says nothing when the balance is unknown", () => {
    expect(stockStatus(null, null)).toBe("unknown");
  });

  it("flags a material that is used up", () => {
    expect(stockStatus(0, 0)).toBe("out");
    expect(stockStatus(-100, null)).toBe("out");
  });

  it("flags a material with few procedures left", () => {
    expect(stockStatus(toMilliUnits(1), LOW_STOCK_SERVICE_THRESHOLD)).toBe("low");
    expect(stockStatus(toMilliUnits(1), LOW_STOCK_SERVICE_THRESHOLD + 1)).toBe("ok");
  });

  it("stays ok when there is stock but no usage figure to judge it by", () => {
    expect(stockStatus(toMilliUnits(15), null)).toBe("ok");
  });
});

describe("purchaseAverages", () => {
  it("weights the average by how much was bought at each price", () => {
    const averages = purchaseAverages([
      { packageQuantity: 3, packageSizeMilliUnits: toMilliUnits(15), unitPackageCostMinor: 180_00 },
      { packageQuantity: 1, packageSizeMilliUnits: toMilliUnits(15), unitPackageCostMinor: 220_00 },
    ]);

    // (3 × 180 + 220) / 4 = 190
    expect(averages.averagePackageCostMinor).toBe(190_00);
    expect(averages.packagesPurchased).toBe(4);
    expect(averages.totalSpentMinor).toBe(760_00);
  });

  it("stays comparable when the packaging changes", () => {
    const averages = purchaseAverages([
      { packageQuantity: 1, packageSizeMilliUnits: toMilliUnits(15), unitPackageCostMinor: 180_00 },
      { packageQuantity: 1, packageSizeMilliUnits: toMilliUnits(30), unitPackageCostMinor: 300_00 },
    ]);

    // 480 MDL for 45 ml = 10.67 MDL/ml, whatever the bottles were.
    expect(averages.averageBaseUnitCostMinor).toBe(1_067);
  });

  it("has no average before the first purchase", () => {
    expect(purchaseAverages([]).averagePackageCostMinor).toBeNull();
    expect(purchaseAverages([]).averageBaseUnitCostMinor).toBeNull();
  });
});

describe("calibrationSuggestion", () => {
  it("reports how far the norms are from what was counted", () => {
    const suggestion = calibrationSuggestion(
      toMilliUnits(6),
      toMilliUnits(3),
      toMilliUnits(6),
    );

    expect(suggestion.driftMilliUnits).toBe(-toMilliUnits(3));
    expect(suggestion.driftBasisPoints).toBe(-5_000);
    expect(suggestion.significant).toBe(true);
  });

  it("stays quiet about a difference that is measurement noise", () => {
    const suggestion = calibrationSuggestion(
      toMilliUnits(6),
      toMilliUnits(5.5),
      toMilliUnits(6),
    );

    expect(suggestion.significant).toBe(false);
  });

  it("has no ratio when nothing was consumed since the last baseline", () => {
    expect(calibrationSuggestion(toMilliUnits(6), toMilliUnits(6), 0).driftBasisPoints).toBeNull();
  });
});
