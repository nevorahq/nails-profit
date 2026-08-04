import { describe, expect, it } from "vitest";

import { calculateCosting, type CostingInput } from "@/domain/costing";

/** Narrows to the complete branch so tests can read figures directly. */
function completeCosting(input: CostingInput) {
  const result = calculateCosting(input);
  if (result.incompleteCostData) {
    throw new Error(`expected a complete costing, got: ${result.incompleteReasons.join(", ")}`);
  }
  return result;
}

describe("calculateCosting", () => {
  it("matches the roadmap Gate 2 canonical scenario", () => {
    const result = completeCosting({
      priceMinor: 60_000,
      materialCostMinor: 3_500,
      durationMinutes: 90,
      currency: "MDL",
      commission: { type: "percentage", basisPoints: 4_000 },
    });

    expect(result).toMatchObject({
      commissionMinor: 24_000,
      contributionMarginMinor: 32_500,
      marginBasisPoints: 5_417,
      profitPerHourMinor: 21_667,
      formulaVersion: "costing-v1",
    });
  });

  it.each([
    [{ type: "fixed", amountMinor: 12_345 } as const, 12_345],
    [{ type: "percentage_after_materials", basisPoints: 4_000 } as const, 22_600],
  ])("supports %o commission", (commission, expected) => {
    expect(
      completeCosting({
        priceMinor: 60_000,
        materialCostMinor: 3_500,
        durationMinutes: 90,
        currency: "MDL",
        commission,
      }).commissionMinor,
    ).toBe(expected);
  });

  it("flags missing material costs instead of treating them as zero", () => {
    const result = calculateCosting({
      priceMinor: 60_000,
      materialCostMinor: null,
      durationMinutes: 90,
      currency: "MDL",
      commission: { type: "fixed", amountMinor: 0 },
    });

    expect(result.incompleteCostData).toBe(true);
    if (!result.incompleteCostData) throw new Error("expected an incomplete result");
    expect(result.incompleteReasons).toEqual(["missing_material_cost"]);
    // The point of the flag: no figure is emitted that could be read as a margin.
    expect(result).not.toHaveProperty("contributionMarginMinor");
    expect(result).not.toHaveProperty("marginBasisPoints");
    expect(result).not.toHaveProperty("profitPerHourMinor");
    expect(result.priceMinor).toBe(60_000);
    expect(result.durationMinutes).toBe(90);
  });

  it("still rejects a zero duration when material data is missing", () => {
    expect(() =>
      calculateCosting({
        priceMinor: 60_000,
        materialCostMinor: null,
        durationMinutes: 0,
        currency: "MDL",
        commission: { type: "fixed", amountMinor: 0 },
      }),
    ).toThrow("durationMinutes");
  });

  it("reports a loss-making service as a loss, not as zero", () => {
    // 300 MDL price, 40% commission (120 MDL), 250 MDL of materials => -70 MDL.
    const result = completeCosting({
      priceMinor: 30_000,
      materialCostMinor: 25_000,
      durationMinutes: 120,
      currency: "MDL",
      commission: { type: "percentage", basisPoints: 4_000 },
    });

    expect(result).toMatchObject({
      contributionMarginMinor: -7_000,
      marginBasisPoints: -2_333,
      profitPerHourMinor: -3_500,
    });
  });

  it("keeps margin and profit per hour consistent in sign", () => {
    const result = completeCosting({
      priceMinor: 20_000,
      materialCostMinor: 18_000,
      durationMinutes: 60,
      currency: "MDL",
      commission: { type: "fixed", amountMinor: 5_000 },
    });

    expect(result.contributionMarginMinor).toBeLessThan(0);
    expect(result.marginBasisPoints).toBeLessThan(0);
    expect(result.profitPerHourMinor).toBeLessThan(0);
  });

  it("reports an undefined margin percentage for a free service", () => {
    const result = completeCosting({
      priceMinor: 0,
      materialCostMinor: 4_000,
      durationMinutes: 60,
      currency: "MDL",
      commission: { type: "fixed", amountMinor: 0 },
    });

    expect(result.marginBasisPoints).toBeNull();
    expect(result.contributionMarginMinor).toBe(-4_000);
    expect(result.profitPerHourMinor).toBe(-4_000);
  });

  it("never charges a negative commission when materials exceed the price", () => {
    const result = completeCosting({
      priceMinor: 10_000,
      materialCostMinor: 15_000,
      durationMinutes: 60,
      currency: "MDL",
      commission: { type: "percentage_after_materials", basisPoints: 4_000 },
    });

    expect(result.commissionMinor).toBe(0);
    expect(result.contributionMarginMinor).toBe(-5_000);
  });

  it("rejects a zero duration", () => {
    expect(() =>
      calculateCosting({
        priceMinor: 60_000,
        materialCostMinor: 3_500,
        durationMinutes: 0,
        currency: "MDL",
        commission: { type: "fixed", amountMinor: 0 },
      }),
    ).toThrow("durationMinutes");
  });
});
