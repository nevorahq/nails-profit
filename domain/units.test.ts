import { describe, expect, it } from "vitest";

import {
  baseUnitCostMinor,
  fromMilliUnits,
  materialCostMinor,
  toMilliUnits,
} from "@/domain/units";

describe("milli-unit quantities", () => {
  it("keeps fractional quantities exact", () => {
    expect(toMilliUnits(15)).toBe(15_000);
    expect(toMilliUnits(0.3)).toBe(300);
    expect(toMilliUnits(0.001)).toBe(1);
    expect(fromMilliUnits(300)).toBe(0.3);
  });

  it("rejects negative or non-finite quantities", () => {
    expect(() => toMilliUnits(-1)).toThrow(RangeError);
    expect(() => toMilliUnits(Number.NaN)).toThrow(RangeError);
    expect(() => toMilliUnits(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("baseUnitCostMinor", () => {
  it("converts a package price to a price per base unit", () => {
    // 240 MDL for a 15 ml bottle => 16 MDL per ml.
    expect(baseUnitCostMinor(24_000, 15_000)).toBe(1_600);
  });

  it("returns null for an unknown or zero package size", () => {
    // Spec 18.2 edge case: a material with a zero or unknown package size has an
    // unknown unit cost, which must never read as free.
    expect(baseUnitCostMinor(24_000, 0)).toBeNull();
    expect(baseUnitCostMinor(24_000, -1)).toBeNull();
    expect(baseUnitCostMinor(24_000, 1.5)).toBeNull();
  });

  it("distinguishes a free material from an unknown one", () => {
    expect(baseUnitCostMinor(0, 15_000)).toBe(0);
    expect(baseUnitCostMinor(24_000, 0)).toBeNull();
  });

  it("rejects a negative package price", () => {
    expect(() => baseUnitCostMinor(-1, 15_000)).toThrow(RangeError);
  });
});

describe("materialCostMinor", () => {
  it("costs a quantity out of a package", () => {
    // 3 ml from a 240 MDL / 15 ml bottle => 48 MDL.
    expect(materialCostMinor(24_000, 15_000, 3_000)).toBe(4_800);
  });

  it("rounds once, so a whole package costs exactly what was paid", () => {
    // The reason the calculation does not multiply a rounded unit price:
    // 240 MDL / 7 ml rounds to 34.29 MDL per ml, and seven of those come to
    // 240.03 MDL. Consuming the whole package must cost the package price.
    const packagePrice = 24_000;
    const packageSize = 7_000;

    const perUnit = baseUnitCostMinor(packagePrice, packageSize);
    expect(perUnit).toBe(3_429);
    expect(perUnit! * 7).toBe(24_003);

    expect(materialCostMinor(packagePrice, packageSize, packageSize)).toBe(24_000);
  });

  it("costs nothing for a zero quantity", () => {
    expect(materialCostMinor(24_000, 15_000, 0)).toBe(0);
  });

  it("returns null when the package size is unusable", () => {
    expect(materialCostMinor(24_000, 0, 3_000)).toBeNull();
  });

  it("rejects a negative quantity", () => {
    expect(() => materialCostMinor(24_000, 15_000, -1)).toThrow(RangeError);
  });

  it("fails loudly rather than silently losing precision on absurd inputs", () => {
    // The intermediate product leaves the safe integer range; roundRatio refuses
    // it instead of returning a number that is quietly wrong.
    expect(() => materialCostMinor(100_000_000, 1, 100_000_000_000)).toThrow(RangeError);
  });

  it("handles piece materials, where a package is a count", () => {
    // 50 disposable files for 150 MDL => 3 MDL each.
    expect(materialCostMinor(15_000, toMilliUnits(50), toMilliUnits(2))).toBe(600);
  });

  it("rounds once, at the end, on the epic's worked example", () => {
    // 185.00 MDL for a 15 ml bottle, 0.6 ml used. The unit price is
    // 12.333333 MDL/ml and is never stored or rounded on its own: rounding it
    // first gives 12.33 × 0.6 = 7.398 → 7.40 by luck here, but 7.38 or 7.42 on
    // neighbouring inputs. Rounding once keeps the arithmetic closed over the
    // package.
    expect(materialCostMinor(18_500, toMilliUnits(15), toMilliUnits(0.6))).toBe(740);
  });
});
