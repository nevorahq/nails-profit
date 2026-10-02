import { describe, expect, it } from "vitest";

import type { CommissionTerms } from "@/domain/visit-commission";
import { splitVisitByService, type SplitFigures, type SplitLine } from "@/domain/visit-split";

const percent: CommissionTerms = {
  ruleKey: "percent",
  commission: { type: "percentage", basisPoints: 4_000 },
  base: "after_discount",
};
const flat: CommissionTerms = {
  ruleKey: "flat",
  commission: { type: "fixed", amountMinor: 15_000 },
  base: "after_discount",
};

function line(overrides: Partial<SplitLine>): SplitLine {
  return {
    serviceId: "manicure",
    priceMinor: 60_000,
    discountMinor: 0,
    refundMinor: 0,
    commissionable: true,
    commissionTerms: percent,
    durationMinutes: 90,
    ...overrides,
  };
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe("splitVisitByService", () => {
  // 600 manicure at 40% + 400 pedicure at a flat 150, with taxes and a fee.
  const lines = [
    line({}),
    line({ serviceId: "pedicure", priceMinor: 40_000, commissionTerms: flat, durationMinutes: 60 }),
  ];
  const figures: SplitFigures = {
    revenueMinor: 100_000,
    commissionMinor: 24_000 + 15_000,
    vatMinor: 16_667,
    turnoverTaxMinor: 1_001,
    payrollTaxMinor: 9_399,
    paymentCommissionMinor: 1_501,
    durationMinutes: 155,
  };

  it("takes revenue and commission from the lines, and shares the rest out", () => {
    const parts = splitVisitByService(figures, lines, percent)!;

    expect(parts.map((part) => part.serviceId)).toEqual(["manicure", "pedicure"]);
    expect(parts.map((part) => part.revenueMinor)).toEqual([60_000, 40_000]);
    // The flat amount is the pedicure's, the percentage the manicure's.
    expect(parts.map((part) => part.commissionMinor)).toEqual([24_000, 15_000]);
    // 155 minutes in the 90:60 the services were planned at.
    expect(parts.map((part) => part.durationMinutes)).toEqual([93, 62]);
  });

  it("adds up to the visit to the unit", () => {
    const parts = splitVisitByService(figures, lines, percent)!;
    const margin =
      figures.revenueMinor -
      figures.vatMinor -
      figures.commissionMinor -
      figures.payrollTaxMinor -
      figures.paymentCommissionMinor -
      figures.turnoverTaxMinor;

    expect(sum(parts.map((part) => part.revenueMinor))).toBe(figures.revenueMinor);
    expect(sum(parts.map((part) => part.commissionMinor))).toBe(figures.commissionMinor);
    expect(sum(parts.map((part) => part.contributionMarginMinor))).toBe(margin);
    expect(sum(parts.map((part) => part.durationMinutes))).toBe(figures.durationMinutes);
  });

  it("lets a loss-making service show its loss", () => {
    const parts = splitVisitByService(
      {
        ...figures,
        revenueMinor: 70_000,
        vatMinor: 0,
        turnoverTaxMinor: 0,
        payrollTaxMinor: 0,
        paymentCommissionMinor: 0,
      },
      [line({}), line({ serviceId: "pedicure", priceMinor: 10_000, commissionTerms: flat, durationMinutes: 60 })],
      percent,
    )!;

    // 100 of revenue against a flat 150.
    expect(parts[1].contributionMarginMinor).toBe(10_000 - 15_000);
  });

  it("splits one rule's percentage between the services it covers by what each contributed", () => {
    const parts = splitVisitByService(
      { ...figures, commissionMinor: 40_000 },
      [line({}), line({ serviceId: "pedicure", priceMinor: 40_000, durationMinutes: 60 })],
      percent,
    )!;

    expect(parts.map((part) => part.commissionMinor)).toEqual([24_000, 16_000]);
  });

  it("gives the service of a legacy add-on, which names none, the add-on", () => {
    const parts = splitVisitByService(
      { ...figures, revenueMinor: 110_000, commissionMinor: 28_000 + 15_000 },
      [
        line({}),
        line({ serviceId: null, priceMinor: 10_000, durationMinutes: 15 }),
        line({ serviceId: "pedicure", priceMinor: 40_000, commissionTerms: flat, durationMinutes: 60 }),
      ],
      percent,
    )!;

    expect(parts.map((part) => part.revenueMinor)).toEqual([70_000, 40_000]);
    expect(parts.map((part) => part.commissionMinor)).toEqual([28_000, 15_000]);
  });

  it("falls back to the visit's rule on lines that carry none", () => {
    const parts = splitVisitByService(
      { ...figures, commissionMinor: 40_000 },
      [line({ commissionTerms: null }), line({ serviceId: "pedicure", priceMinor: 40_000, commissionTerms: null })],
      percent,
    )!;

    expect(parts.map((part) => part.commissionMinor)).toEqual([24_000, 16_000]);
  });

  it("leaves a visit of one service to be counted whole", () => {
    expect(splitVisitByService(figures, [line({}), line({ priceMinor: 10_000 })], percent)).toBeNull();
    expect(splitVisitByService(figures, [line({ serviceId: null })], percent)).toBeNull();
  });
});
