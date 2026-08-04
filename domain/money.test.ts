import { describe, expect, it } from "vitest";

import { roundRatio, toMoneyJson } from "@/domain/money";

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
