import { describe, expect, it } from "vitest";

import { allocateProportionally, roundRatio, toMoneyJson } from "@/domain/money";

describe("toMoneyJson", () => {
  it("serialises minor units without converting to a float", () => {
    expect(toMoneyJson(12_550, "MDL")).toEqual({ amount: 12_550, currency: "MDL" });
    expect(toMoneyJson(-7_000, "EUR")).toEqual({ amount: -7_000, currency: "EUR" });
  });

  it("refuses a non-integer amount", () => {
    expect(() => toMoneyJson(125.5, "MDL")).toThrow(RangeError);
  });
});

describe("roundRatio", () => {
  it("rounds a loss to the same magnitude as the equivalent gain", () => {
    expect(roundRatio(-7_000 * 10_000, 30_000)).toBe(-roundRatio(7_000 * 10_000, 30_000));
    expect(roundRatio(-1_950_045, 90)).toBe(-roundRatio(1_950_045, 90));
  });

  it("rounds half away from zero", () => {
    expect(roundRatio(5, 10)).toBe(1);
    expect(roundRatio(-5, 10)).toBe(-1);
    expect(roundRatio(4, 10)).toBe(0);
    expect(roundRatio(-4, 10)).toBe(0);
  });

  it("rejects an unusable denominator", () => {
    expect(() => roundRatio(100, 0)).toThrow(RangeError);
    expect(() => roundRatio(100, -10)).toThrow(RangeError);
  });

  it("rejects operands that cannot be represented exactly", () => {
    expect(() => roundRatio(Number.MAX_SAFE_INTEGER + 1, 10)).toThrow(RangeError);
  });
});

describe("allocateProportionally", () => {
  it("splits in proportion and sums exactly to the amount", () => {
    expect(allocateProportionally(10_000, [30_000, 20_000])).toEqual([6_000, 4_000]);
    const parts = allocateProportionally(100, [1, 1, 1]);
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(100);
    // 33.33 each: the leftover unit goes to the earliest of the equal parts.
    expect(parts).toEqual([34, 33, 33]);
  });

  it("gives a tied leftover unit to the larger weight", () => {
    // 3 over [1, 1] is 1.5 each: equal weights, so the earlier one takes it.
    expect(allocateProportionally(3, [1, 1])).toEqual([2, 1]);
    // 1 over [2, 2, 1] is .4, .4, .2: the unit goes to the first of the larger.
    expect(allocateProportionally(1, [2, 2, 1])).toEqual([1, 0, 0]);
  });

  it("leaves a zero weight out unless every weight is zero", () => {
    expect(allocateProportionally(500, [0, 500])).toEqual([0, 500]);
    expect(allocateProportionally(5, [0, 0])).toEqual([3, 2]);
  });

  it("stays exact where amount × weight passes 2^53", () => {
    const parts = allocateProportionally(99_999_999, [99_999_999, 99_999_998, 1]);
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(99_999_999);
    expect(parts[2]).toBe(0);
  });

  it("allocates nothing over nothing, and refuses an amount over no parts", () => {
    expect(allocateProportionally(0, [])).toEqual([]);
    expect(() => allocateProportionally(1, [])).toThrow(RangeError);
  });

  it("refuses a negative or fractional amount and a negative weight", () => {
    expect(() => allocateProportionally(-1, [1])).toThrow(RangeError);
    expect(() => allocateProportionally(1.5, [1])).toThrow(RangeError);
    expect(() => allocateProportionally(1, [-1, 2])).toThrow(RangeError);
  });
});
