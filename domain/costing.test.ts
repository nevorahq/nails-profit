import { describe, expect, it } from "vitest";

import { calculateCosting, CURRENT_FORMULA_VERSION, type CostingInput } from "@/domain/costing";

/**
 * Kept as a name rather than inlined: every test below used to go through it
 * because the engine could return an incomplete result, and the calls read the
 * same now that it cannot.
 */
const completeCosting = (input: CostingInput) => calculateCosting(input);

describe("calculateCosting", () => {
  it("matches the roadmap Gate 2 canonical scenario", () => {
    const result = completeCosting({
      priceMinor: 60_000,
      durationMinutes: 90,
      currency: "MDL",
      commission: { type: "percentage", basisPoints: 4_000 },
    });

    // The margin is the 35 MDL of material higher than Gate 2 first wrote down:
    // there is nothing to subtract for materials any more.
    expect(result).toMatchObject({
      commissionMinor: 24_000,
      contributionMarginMinor: 36_000,
      marginBasisPoints: 6_000,
      profitPerHourMinor: 24_000,
      formulaVersion: CURRENT_FORMULA_VERSION,
    });
  });

  it.each([
    [{ type: "fixed", amountMinor: 12_345 } as const, 12_345],
    [{ type: "percentage", basisPoints: 4_000 } as const, 24_000],
  ])("supports %o commission", (commission, expected) => {
    expect(
      completeCosting({
        priceMinor: 60_000,
        durationMinutes: 90,
        currency: "MDL",
        commission,
      }).commissionMinor,
    ).toBe(expected);
  });

  it("reports a loss-making service as a loss, not as zero", () => {
    // 300 MDL price against a 370 MDL guaranteed payment to the master => -70.
    const result = completeCosting({
      priceMinor: 30_000,
      durationMinutes: 120,
      currency: "MDL",
      commission: { type: "fixed", amountMinor: 37_000 },
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
      durationMinutes: 60,
      currency: "MDL",
      commission: { type: "fixed", amountMinor: 23_000 },
    });

    expect(result.contributionMarginMinor).toBeLessThan(0);
    expect(result.marginBasisPoints).toBeLessThan(0);
    expect(result.profitPerHourMinor).toBeLessThan(0);
  });

  it("reports an undefined margin percentage for a free service", () => {
    const result = completeCosting({
      priceMinor: 0,
      durationMinutes: 60,
      currency: "MDL",
      commission: { type: "fixed", amountMinor: 4_000 },
    });

    expect(result.marginBasisPoints).toBeNull();
    expect(result.contributionMarginMinor).toBe(-4_000);
    expect(result.profitPerHourMinor).toBe(-4_000);
  });

  it("rejects a zero duration", () => {
    expect(() =>
      calculateCosting({
        priceMinor: 60_000,
        durationMinutes: 0,
        currency: "MDL",
        commission: { type: "fixed", amountMinor: 0 },
      }),
    ).toThrow("durationMinutes");
  });
});
/*
 * The tax and acquiring terms, which are additions with a zero default: a
 * studio that has entered neither gets the plain price-minus-commission figure.
 */
describe("taxes and acquiring", () => {
  const canonical = {
    priceMinor: 60_000,
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
    expect(result.contributionMarginMinor).toBe(36_000);
    expect(result.marginBasisPoints).toBe(6_000);
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
    expect(result.contributionMarginMinor).toBe(26_000);
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
    expect(result.contributionMarginMinor).toBe(36_000);
  });

  it("charges turnover tax on revenue net of the VAT handed on", () => {
    const result = completeCosting({
      ...canonical,
      taxes: { vatBasisPoints: 2_000, remittableVat: true, turnoverBasisPoints: 400, payrollBasisPoints: 0 },
    });

    // 4% of 500, not of 600: the state's share was never turnover of the studio.
    expect(result.turnoverTaxMinor).toBe(2_000);
    expect(result.contributionMarginMinor).toBe(24_000);
  });

  it("charges payroll contributions on the commission and nothing else", () => {
    const result = completeCosting({
      ...canonical,
      taxes: { vatBasisPoints: 0, remittableVat: false, turnoverBasisPoints: 0, payrollBasisPoints: 2_400 },
    });

    expect(result.payrollTaxMinor).toBe(5_760);
    expect(result.contributionMarginMinor).toBe(36_000 - 5_760);
  });

  it("adds the acquirer's percentage and its flat fee", () => {
    const result = completeCosting({
      ...canonical,
      payment: { basisPoints: 220, fixedFeeMinor: 100, chargedMinor: 60_000 },
    });

    expect(result.paymentCommissionMinor).toBe(1_320 + 100);
    expect(result.contributionMarginMinor).toBe(36_000 - 1_420);
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
 * The hybrid form and the commission base. A rule that names neither produces
 * the plain percentage of the revenue.
 */
describe("hybrid commission and the commission base", () => {
  const canonical = {
    priceMinor: 60_000,
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
    expect(partial.contributionMarginMinor).toBe(60_000 - 12_000);
  });

  it("uses the base for the hybrid share too", () => {
    const result = completeCosting({
      ...canonical,
      commission: { type: "hybrid", amountMinor: 5_000, basisPoints: 2_000 },
      commissionBaseMinor: 30_000,
    });

    expect(result.commissionMinor).toBe(5_000 + 6_000);
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
