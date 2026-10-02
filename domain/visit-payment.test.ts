import { describe, expect, it } from "vitest";

import { applyPaidAmount, spreadDiscount } from "@/domain/visit-payment";

const charged = (lines: readonly { priceMinor: number; discountMinor: number }[]) =>
  lines.reduce((sum, line) => sum + line.priceMinor - line.discountMinor, 0);

describe("spreadDiscount", () => {
  it("leaves the lines alone when there is nothing to take off", () => {
    const lines = [{ priceMinor: 50_000, discountMinor: 0 }];
    expect(spreadDiscount(lines, 0)).toEqual(lines);
  });

  it("takes the whole amount off a single line", () => {
    expect(spreadDiscount([{ priceMinor: 50_000, discountMinor: 0 }], 5_000)).toEqual([
      { priceMinor: 50_000, discountMinor: 5_000 },
    ]);
  });

  it("spreads in proportion to what each line charges", () => {
    const result = spreadDiscount(
      [
        { priceMinor: 60_000, discountMinor: 0 },
        { priceMinor: 20_000, discountMinor: 0 },
      ],
      8_000,
    );
    expect(result.map((line) => line.discountMinor)).toEqual([6_000, 2_000]);
  });

  it("adds to a discount the line already carried", () => {
    const result = spreadDiscount([{ priceMinor: 50_000, discountMinor: 10_000 }], 1_000);
    expect(result[0].discountMinor).toBe(11_000);
  });

  it("gives the leftover units to the largest remainders so the total is exact", () => {
    const lines = [
      { priceMinor: 100, discountMinor: 0 },
      { priceMinor: 100, discountMinor: 0 },
      { priceMinor: 100, discountMinor: 0 },
    ];
    const result = spreadDiscount(lines, 200);
    expect(result.reduce((sum, line) => sum + line.discountMinor, 0)).toBe(200);
    expect(result.every((line) => line.discountMinor <= line.priceMinor)).toBe(true);
  });

  it("never discounts a line past its own price, even with tiny lines", () => {
    const lines = [
      { priceMinor: 1, discountMinor: 0 },
      { priceMinor: 1, discountMinor: 0 },
      { priceMinor: 1, discountMinor: 0 },
    ];
    const result = spreadDiscount(lines, 2);
    expect(result.map((line) => line.discountMinor).sort()).toEqual([0, 1, 1]);
  });

  it("caps the amount at what the lines charge", () => {
    const result = spreadDiscount(
      [
        { priceMinor: 30_000, discountMinor: 0 },
        { priceMinor: 10_000, discountMinor: 0 },
      ],
      99_000,
    );
    expect(charged(result)).toBe(0);
    expect(result.map((line) => line.discountMinor)).toEqual([30_000, 10_000]);
  });

  it("skips a line that charges nothing", () => {
    const result = spreadDiscount(
      [
        { priceMinor: 0, discountMinor: 0 },
        { priceMinor: 40_000, discountMinor: 0 },
      ],
      4_000,
    );
    expect(result.map((line) => line.discountMinor)).toEqual([0, 4_000]);
  });

  it("keeps the other fields of each line", () => {
    const [line] = spreadDiscount([{ priceMinor: 500, discountMinor: 0, kind: "service" as const }], 100);
    expect(line.kind).toBe("service");
  });
});

describe("applyPaidAmount", () => {
  const lines = [
    { priceMinor: 50_000, discountMinor: 0 },
    { priceMinor: 10_000, discountMinor: 0 },
  ];

  it("changes nothing when the client paid the price list", () => {
    expect(applyPaidAmount(lines, 60_000)).toEqual({ lines, surchargeMinor: 0 });
  });

  it("turns paying less into discount that adds up to the amount paid", () => {
    const result = applyPaidAmount(lines, 45_000);
    expect(result.surchargeMinor).toBe(0);
    expect(charged(result.lines)).toBe(45_000);
  });

  it("turns paying more into a surcharge and leaves the price list as it was", () => {
    const result = applyPaidAmount(lines, 65_000);
    expect(result.lines).toEqual(lines);
    expect(result.surchargeMinor).toBe(5_000);
  });

  it("allows a visit that was given away", () => {
    const result = applyPaidAmount(lines, 0);
    expect(charged(result.lines)).toBe(0);
  });

  it("refuses a negative or fractional amount", () => {
    expect(() => applyPaidAmount(lines, -1)).toThrow(RangeError);
    expect(() => applyPaidAmount(lines, 1.5)).toThrow(RangeError);
  });
});
