import { describe, expect, it } from "vitest";

import { resolveEffectiveMaterialUsage, type MaterialUsageLine } from "@/domain/material-usage";
import { toMilliUnits } from "@/domain/units";

const line = (overrides: Partial<MaterialUsageLine> = {}): MaterialUsageLine => ({
  materialId: "gel",
  standardQuantityMilliUnits: toMilliUnits(2),
  actualQuantityMilliUnits: null,
  packagePriceMinor: 10_000,
  packageSizeMilliUnits: toMilliUnits(10),
  ...overrides,
});

describe("resolveEffectiveMaterialUsage", () => {
  it("uses standard usage when no actual override exists", () => {
    const result = resolveEffectiveMaterialUsage([line()]);

    expect(result.source).toBe("standard");
    expect(result.standardTotalMinor).toBe(2_000);
    expect(result.effectiveTotalMinor).toBe(2_000);
  });

  it("uses an actual override when one exists", () => {
    const result = resolveEffectiveMaterialUsage([
      line({ actualQuantityMilliUnits: toMilliUnits(4) }),
    ]);

    expect(result.source).toBe("actual");
    expect(result.standardTotalMinor).toBe(2_000);
    expect(result.effectiveTotalMinor).toBe(4_000);
  });

  it("falls back to standard per item for a partial override", () => {
    const result = resolveEffectiveMaterialUsage([
      line({ actualQuantityMilliUnits: toMilliUnits(3) }),
      line({
        materialId: "top",
        standardQuantityMilliUnits: toMilliUnits(1),
      }),
    ]);

    expect(result.source).toBe("actual");
    expect(result.effectiveTotalMinor).toBe(4_000);
    expect(result.items.map((item) => item.source)).toEqual(["actual", "standard"]);
  });

  it("treats zero as an explicit removal rather than as a missing value", () => {
    const result = resolveEffectiveMaterialUsage([line({ actualQuantityMilliUnits: 0 })]);

    expect(result.source).toBe("actual");
    expect(result.effectiveTotalMinor).toBe(0);
  });

  it("does not require a price for an explicitly removed material", () => {
    const result = resolveEffectiveMaterialUsage([
      line({
        actualQuantityMilliUnits: 0,
        packagePriceMinor: null,
        packageSizeMilliUnits: null,
      }),
    ]);

    expect(result.standardTotalMinor).toBeNull();
    expect(result.effectiveTotalMinor).toBe(0);
    expect(result.blockingMaterialIds).toEqual([]);
  });

  it("keeps a missing price unknown", () => {
    const result = resolveEffectiveMaterialUsage([
      line({ packagePriceMinor: null, packageSizeMilliUnits: null }),
    ]);

    expect(result.effectiveTotalMinor).toBeNull();
    expect(result.blockingMaterialIds).toEqual(["gel"]);
  });

  it("supports an extra material as zero standard plus an actual quantity", () => {
    const result = resolveEffectiveMaterialUsage([
      line({
        standardQuantityMilliUnits: 0,
        actualQuantityMilliUnits: toMilliUnits(1),
      }),
    ]);

    expect(result.standardTotalMinor).toBe(0);
    expect(result.effectiveTotalMinor).toBe(1_000);
    expect(result.source).toBe("actual");
  });
});
