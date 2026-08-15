import { describe, expect, it } from "vitest";

import { calculateCosting, CURRENT_FORMULA_VERSION, type CostingInput } from "@/domain/costing";

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
      formulaVersion: CURRENT_FORMULA_VERSION,
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
/*
 * The `costing-v2` terms. Every test above this line passes unchanged, which is
 * the point: taxes and acquiring are additions with a zero default, and a
 * studio that has entered neither gets the figures it has always had.
 */
describe("taxes and acquiring", () => {
  const canonical = {
    priceMinor: 60_000,
    materialCostMinor: 3_500,
    durationMinutes: 90,
    currency: "MDL" as const,
    commission: { type: "percentage", basisPoints: 4_000 } as const,
  };

  it("reproduces the v1 figures when nothing has been entered", () => {
    const result = completeCosting(canonical);

    expect(result.netRevenueMinor).toBe(60_000);
    expect(result.vatMinor).toBe(0);
    expect(result.turnoverTaxMinor).toBe(0);
    expect(result.paymentCommissionMinor).toBe(0);
    expect(result.payrollTaxMinor).toBe(0);
    expect(result.contributionMarginMinor).toBe(32_500);
    expect(result.marginBasisPoints).toBe(5_417);
  });

  it("takes VAT out of the price rather than adding it on top", () => {
    const result = completeCosting({
      ...canonical,
      taxes: { vatBasisPoints: 2_000, remittableVat: true, turnoverBasisPoints: 0, payrollBasisPoints: 0 },
    });

    // 600 charged at 20% inclusive: 100 is the state's, 500 is the studio's.
    // Adding 20% on top would invent 120 of revenue nobody was charged.
    expect(result.vatMinor).toBe(10_000);
    expect(result.netRevenueMinor).toBe(50_000);
    expect(result.contributionMarginMinor).toBe(22_500);
  });

  it("leaves the master's commission on the price the client paid", () => {
    const withVat = completeCosting({
      ...canonical,
      taxes: { vatBasisPoints: 2_000, remittableVat: true, turnoverBasisPoints: 0, payrollBasisPoints: 0 },
    });

    // «40% от чека» does not become 40% of something smaller the day a VAT rate
    // is entered — that would re-cut every arrangement in the studio silently.
    expect(withVat.commissionMinor).toBe(24_000);
  });

  it("records a VAT rate that is not remitted without taking it out", () => {
    const result = completeCosting({
      ...canonical,
      taxes: { vatBasisPoints: 2_000, remittableVat: false, turnoverBasisPoints: 0, payrollBasisPoints: 0 },
    });

    expect(result.vatMinor).toBe(0);
    expect(result.netRevenueMinor).toBe(60_000);
    expect(result.contributionMarginMinor).toBe(32_500);
  });

  it("charges turnover tax on revenue net of the VAT handed on", () => {
    const result = completeCosting({
      ...canonical,
      taxes: { vatBasisPoints: 2_000, remittableVat: true, turnoverBasisPoints: 400, payrollBasisPoints: 0 },
    });

    // 4% of 500, not of 600: the state's share was never turnover of the studio.
    expect(result.turnoverTaxMinor).toBe(2_000);
    expect(result.contributionMarginMinor).toBe(20_500);
  });

  it("charges payroll contributions on the commission and nothing else", () => {
    const result = completeCosting({
      ...canonical,
      taxes: { vatBasisPoints: 0, remittableVat: false, turnoverBasisPoints: 0, payrollBasisPoints: 2_400 },
    });

    expect(result.payrollTaxMinor).toBe(5_760);
    expect(result.contributionMarginMinor).toBe(32_500 - 5_760);
  });

  it("adds the acquirer's percentage and its flat fee", () => {
    const result = completeCosting({
      ...canonical,
      payment: { basisPoints: 220, fixedFeeMinor: 100, chargedMinor: 60_000 },
    });

    expect(result.paymentCommissionMinor).toBe(1_320 + 100);
    expect(result.contributionMarginMinor).toBe(32_500 - 1_420);
  });

  /*
   * The base of the acquirer's fee is the sum the terminal processed, which is
   * why `chargedMinor` is passed rather than inferred from the price: after a
   * refund the two differ, and the bank does not give its fee back.
   */
  it("charges the acquirer's fee on what was processed, not on what was kept", () => {
    const result = completeCosting({
      ...canonical,
      priceMinor: 40_000,
      payment: { basisPoints: 220, fixedFeeMinor: 0, chargedMinor: 60_000 },
    });

    expect(result.paymentCommissionMinor).toBe(1_320);
  });

  it("takes no flat fee from a visit that processed nothing", () => {
    const result = completeCosting({
      ...canonical,
      priceMinor: 0,
      commission: { type: "fixed", amountMinor: 0 },
      payment: { basisPoints: 220, fixedFeeMinor: 100, chargedMinor: 0 },
    });

    expect(result.paymentCommissionMinor).toBe(0);
  });

  it("measures the margin against net revenue, not against the price", () => {
    const result = completeCosting({
      ...canonical,
      materialCostMinor: 0,
      commission: { type: "fixed", amountMinor: 0 },
      taxes: { vatBasisPoints: 2_000, remittableVat: true, turnoverBasisPoints: 0, payrollBasisPoints: 0 },
    });

    // Everything the studio kept, it kept: 100%. Against the price it would
    // read 83%, punishing a business for collecting a tax it never owned.
    expect(result.marginBasisPoints).toBe(10_000);
  });

  it("subtracts each term exactly once", () => {
    const result = completeCosting({
      ...canonical,
      taxes: { vatBasisPoints: 2_000, remittableVat: true, turnoverBasisPoints: 400, payrollBasisPoints: 2_400 },
      payment: { basisPoints: 220, fixedFeeMinor: 100, chargedMinor: 60_000 },
    });

    expect(result.contributionMarginMinor).toBe(
      result.netRevenueMinor -
        result.materialCostMinor -
        result.commissionMinor -
        result.payrollTaxMinor -
        result.paymentCommissionMinor -
        result.turnoverTaxMinor,
    );
  });

  it("charges the acquirer's fee on what was processed, not on what was kept — again", () => {
    // Guard against the base and the fee being wired to the same number.
    const result = completeCosting({
      ...canonical,
      commissionBaseMinor: 30_000,
      payment: { basisPoints: 220, fixedFeeMinor: 0, chargedMinor: 60_000 },
    });

    expect(result.paymentCommissionMinor).toBe(1_320);
  });

  it("refuses a negative rate rather than quietly paying it back", () => {
    expect(() =>
      calculateCosting({
        ...canonical,
        payment: { basisPoints: -220, fixedFeeMinor: 0, chargedMinor: 60_000 },
      }),
    ).toThrow("payment.basisPoints");
  });
});

/*
 * The `costing-v2` commission forms. As with taxes, everything above passes
 * unchanged: a rule that names no base and no services produces the same
 * number it always did.
 */
describe("hybrid commission and the commission base", () => {
  const canonical = {
    priceMinor: 60_000,
    materialCostMinor: 3_500,
    durationMinutes: 90,
    currency: "MDL" as const,
  };

  it("adds the guaranteed amount to the share, and does not compare them", () => {
    const result = completeCosting({
      ...canonical,
      commission: { type: "hybrid", amountMinor: 10_000, basisPoints: 2_000 },
    });

    // 100 guaranteed plus 20% of 600. «Больше из двух» is a different deal and
    // would have to be a different type, not a quieter reading of this one.
    expect(result.commissionMinor).toBe(10_000 + 12_000);
  });

  it("pays the guaranteed part even when the visit brought nothing in", () => {
    const result = completeCosting({
      ...canonical,
      priceMinor: 0,
      materialCostMinor: 0,
      commission: { type: "hybrid", amountMinor: 10_000, basisPoints: 2_000 },
    });

    expect(result.commissionMinor).toBe(10_000);
    expect(result.contributionMarginMinor).toBe(-10_000);
  });

  it("applies the percentage to the base the caller worked out", () => {
    const whole = completeCosting({
      ...canonical,
      commission: { type: "percentage", basisPoints: 4_000 },
    });
    const partial = completeCosting({
      ...canonical,
      commission: { type: "percentage", basisPoints: 4_000 },
      commissionBaseMinor: 30_000,
    });

    expect(whole.commissionMinor).toBe(24_000);
    expect(partial.commissionMinor).toBe(12_000);
    // The revenue itself is untouched: a narrower commission base does not make
    // the visit smaller, only the master's share of it.
    expect(partial.netRevenueMinor).toBe(60_000);
    expect(partial.contributionMarginMinor).toBe(60_000 - 3_500 - 12_000);
  });

  it("uses the base for the hybrid share too", () => {
    const result = completeCosting({
      ...canonical,
      commission: { type: "hybrid", amountMinor: 5_000, basisPoints: 2_000 },
      commissionBaseMinor: 30_000,
    });

    expect(result.commissionMinor).toBe(5_000 + 6_000);
  });

  it("takes materials off the base, not off the whole price, when the type says so", () => {
    const result = completeCosting({
      ...canonical,
      commission: { type: "percentage_after_materials", basisPoints: 4_000 },
      commissionBaseMinor: 30_000,
    });

    // The master used the whole bottle whichever line it went on, so the
    // materials come off in full.
    expect(result.commissionMinor).toBe(10_600);
  });

  it("falls back to the revenue when no base is given", () => {
    const result = completeCosting({
      ...canonical,
      commission: { type: "percentage", basisPoints: 4_000 },
    });

    expect(result.commissionMinor).toBe(24_000);
  });

  it("refuses a negative base", () => {
    expect(() =>
      calculateCosting({
        ...canonical,
        commission: { type: "percentage", basisPoints: 4_000 },
        commissionBaseMinor: -1,
      }),
    ).toThrow("commissionBaseMinor");
  });

  it("refuses a hybrid missing half of itself", () => {
    expect(() =>
      calculateCosting({
        ...canonical,
        commission: { type: "hybrid", amountMinor: -1, basisPoints: 2_000 },
      }),
    ).toThrow("commission.amountMinor");
  });
});
