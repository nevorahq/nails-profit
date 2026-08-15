import { describe, expect, it } from "vitest";

import { hasAnyTax, selectTaxRates, type TaxRuleRow } from "@/domain/tax-rules";

function rule(overrides: Partial<TaxRuleRow> = {}): TaxRuleRow {
  return {
    kind: "vat",
    basisPoints: 2_000,
    remittable: true,
    activeFrom: new Date("2026-01-01T00:00:00.000Z"),
    activeTo: null,
    ...overrides,
  };
}

const MARCH = new Date("2026-03-15T10:00:00.000Z");

describe("selectTaxRates", () => {
  it("answers all zeros when nothing has been entered", () => {
    expect(selectTaxRates([], MARCH)).toEqual({
      vatBasisPoints: 0,
      remittableVat: false,
      turnoverBasisPoints: 0,
      payrollBasisPoints: 0,
    });
  });

  it("reads one rate per kind", () => {
    const rates = selectTaxRates(
      [rule(), rule({ kind: "turnover", basisPoints: 400 }), rule({ kind: "payroll", basisPoints: 2_400 })],
      MARCH,
    );

    expect(rates).toEqual({
      vatBasisPoints: 2_000,
      remittableVat: true,
      turnoverBasisPoints: 400,
      payrollBasisPoints: 2_400,
    });
  });

  it("ignores a rule that has not started", () => {
    const future = rule({ activeFrom: new Date("2026-07-01T00:00:00.000Z"), basisPoints: 1_200 });

    expect(selectTaxRates([future], MARCH).vatBasisPoints).toBe(0);
  });

  it("ignores a rule that has ended", () => {
    const ended = rule({ activeTo: new Date("2026-02-01T00:00:00.000Z") });

    expect(selectTaxRates([ended], MARCH).vatBasisPoints).toBe(0);
  });

  /*
   * The reason this is a selector and not a sum: two VAT rules that overlap are
   * a data error, and adding them would charge a rate no law anywhere sets.
   */
  it("takes the newer of two overlapping rules rather than both", () => {
    const rates = selectTaxRates(
      [rule({ basisPoints: 2_000 }), rule({ basisPoints: 800, activeFrom: new Date("2026-02-01T00:00:00.000Z") })],
      MARCH,
    );

    expect(rates.vatBasisPoints).toBe(800);
  });

  it("still reports a rate that is recorded but not remitted", () => {
    const rates = selectTaxRates([rule({ remittable: false })], MARCH);

    // The rate is kept in the snapshot; `calculateCosting` is what declines to
    // take it out of revenue.
    expect(rates.vatBasisPoints).toBe(2_000);
    expect(rates.remittableVat).toBe(false);
  });

  it("resolves for the moment asked about, not for now", () => {
    const rules = [
      rule({ basisPoints: 2_000, activeTo: new Date("2026-06-01T00:00:00.000Z") }),
      rule({ basisPoints: 800, activeFrom: new Date("2026-06-01T00:00:00.000Z") }),
    ];

    expect(selectTaxRates(rules, MARCH).vatBasisPoints).toBe(2_000);
    expect(selectTaxRates(rules, new Date("2026-09-01T00:00:00.000Z")).vatBasisPoints).toBe(800);
  });
});

describe("hasAnyTax", () => {
  it("is false for a studio that has entered nothing", () => {
    expect(hasAnyTax(selectTaxRates([], MARCH))).toBe(false);
  });

  it("is false for a VAT rate that is not handed on", () => {
    // Nothing would be subtracted, so the visit needs no snapshot and «налогов
    // не было» stays distinguishable from «никто не спрашивал».
    expect(hasAnyTax(selectTaxRates([rule({ remittable: false })], MARCH))).toBe(false);
  });

  it("is true as soon as one rate would move a figure", () => {
    expect(hasAnyTax(selectTaxRates([rule({ kind: "payroll", basisPoints: 1 })], MARCH))).toBe(true);
  });
});
