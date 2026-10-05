import { describe, expect, it } from "vitest";

import { calculateCosting } from "@/domain/costing";
import { workedExample } from "@/domain/worked-example";

describe("the worked example on «Как считается»", () => {
  const example = workedExample("MDL");

  it("walks one visit from the price to what it leaves", () => {
    expect(example).toMatchObject({
      priceMinor: 60_000,
      masterPayMinor: 24_000,
      materialsMinor: 3_500,
      leftMinor: 32_500,
    });
    // The page prints it as one subtraction; the subtraction has to hold.
    expect(example.priceMinor - example.masterPayMinor - example.materialsMinor).toBe(example.leftMinor);
  });

  it("divides what the visit leaves by its hours, as the service card does", () => {
    // 325.00 over an hour and a half.
    expect(example.perHourMinor).toBe(21_667);
    expect(example.perHourMinor).toBe(
      calculateCosting({
        priceMinor: 60_000,
        durationMinutes: 90,
        currency: "MDL",
        commission: { type: "percentage", basisPoints: 4_000 },
        materialsMinor: 3_500,
      }).profitPerHourMinor,
    );
  });

  it("sums the month and takes off what no visit pays for", () => {
    expect(example.leftAfterVisitsMinor).toBe(60 * 32_500);
    expect(example.leftForMonthMinor).toBe(1_950_000 - 1_200_000);
  });
});
