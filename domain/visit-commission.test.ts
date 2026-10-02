import { describe, expect, it } from "vitest";

import { calculateCosting } from "@/domain/costing";
import { commissionOfLines, type CommissionTerms } from "@/domain/visit-commission";
import { calculateVisitProfit } from "@/domain/visit-profit";

const visitRule: CommissionTerms = {
  ruleKey: "visit",
  commission: { type: "percentage", basisPoints: 4_000 },
  base: "after_discount",
};

const flat: CommissionTerms = {
  ruleKey: "flat",
  commission: { type: "fixed", amountMinor: 15_000 },
  base: "after_discount",
};

describe("commissionOfLines", () => {
  it("costs lines without terms of their own under the visit's rule, as one group", () => {
    const result = commissionOfLines(
      [
        { priceMinor: 1_001, discountMinor: 0 },
        { priceMinor: 1_001, discountMinor: 0 },
      ],
      visitRule,
    );

    // Rounded once: 40% of 20.02 is 8.008 → 8.01. Rounding each line would
    // give 4.00 + 4.00 and lose a unit the visit-level rule always paid.
    expect(result.totalMinor).toBe(801);
    expect(result.groups).toEqual([{ ruleKey: "visit", commissionMinor: 801, lineIndexes: [0, 1] }]);
  });

  it("matches the costing engine for every rule type when one rule covers the visit", () => {
    const lines = [
      { priceMinor: 50_001, discountMinor: 1_000 },
      { priceMinor: 9_999, discountMinor: 0, refundMinor: 500 },
    ];
    const base = 50_001 - 1_000 + 9_999 - 500;
    for (const commission of [
      { type: "percentage", basisPoints: 3_333 } as const,
      { type: "fixed", amountMinor: 12_345 } as const,
      { type: "hybrid", basisPoints: 1_250, amountMinor: 5_000 } as const,
    ]) {
      const engine = calculateCosting({
        priceMinor: base,
        durationMinutes: 60,
        currency: "MDL",
        commission,
        commissionBaseMinor: base,
      });
      expect(
        commissionOfLines(lines, { ruleKey: "visit", commission, base: "after_discount" }).totalMinor,
      ).toBe(engine.commissionMinor);
    }
  });

  it("pays each rule on its own lines when the services fall under different rules", () => {
    const result = commissionOfLines(
      [
        { priceMinor: 50_000, discountMinor: 0, terms: visitRule },
        { priceMinor: 10_000, discountMinor: 0, terms: visitRule },
        { priceMinor: 40_000, discountMinor: 0, terms: flat },
      ],
      visitRule,
    );

    // 40% of 600 + a flat 150, not 40% of 1 000.
    expect(result.totalMinor).toBe(24_000 + 15_000);
    expect(result.groups.map((group) => [group.ruleKey, group.commissionMinor])).toEqual([
      ["visit", 24_000],
      ["flat", 15_000],
    ]);
  });

  it("pays a fixed amount once per rule, however many lines it covers", () => {
    const result = commissionOfLines(
      [
        { priceMinor: 50_000, discountMinor: 0, terms: flat },
        { priceMinor: 40_000, discountMinor: 0, terms: flat },
      ],
      visitRule,
    );

    expect(result.totalMinor).toBe(15_000);
  });

  it("pays a hybrid's fixed part once and its share on the whole group", () => {
    const hybrid: CommissionTerms = {
      ruleKey: "hybrid",
      commission: { type: "hybrid", basisPoints: 1_000, amountMinor: 5_000 },
      base: "after_discount",
    };
    const result = commissionOfLines(
      [
        { priceMinor: 30_000, discountMinor: 0, terms: hybrid },
        { priceMinor: 20_000, discountMinor: 0, terms: hybrid },
      ],
      visitRule,
    );

    expect(result.totalMinor).toBe(5_000 + 5_000);
  });

  it("takes each group's percentage on its own base", () => {
    const sticker: CommissionTerms = {
      ruleKey: "sticker",
      commission: { type: "percentage", basisPoints: 5_000 },
      base: "full_price",
    };
    const result = commissionOfLines(
      [
        // after_discount: 40% of 400.
        { priceMinor: 50_000, discountMinor: 10_000, terms: visitRule },
        // full_price: 50% of 300, the discount ignored.
        { priceMinor: 30_000, discountMinor: 6_000, terms: sticker },
      ],
      visitRule,
    );

    expect(result.totalMinor).toBe(16_000 + 15_000);
    expect(result.lineBaseMinor).toEqual([40_000, 30_000]);
  });

  it("leaves a line the rule does not cover out of the base, but not the fixed amount", () => {
    const result = commissionOfLines(
      [
        { priceMinor: 40_000, discountMinor: 0, commissionable: false, terms: flat },
        { priceMinor: 40_000, discountMinor: 0, commissionable: false, terms: visitRule },
      ],
      visitRule,
    );

    expect(result.lineBaseMinor).toEqual([0, 0]);
    expect(result.totalMinor).toBe(15_000);
  });

  it("refuses a negative rate, a negative amount and a negative base", () => {
    expect(() =>
      commissionOfLines([{ priceMinor: 1, discountMinor: 0 }], {
        ...visitRule,
        commission: { type: "percentage", basisPoints: -1 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      commissionOfLines([{ priceMinor: 1, discountMinor: 0 }], {
        ...visitRule,
        commission: { type: "fixed", amountMinor: -1 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      commissionOfLines([{ priceMinor: 1, discountMinor: 0, refundMinor: 2 }], visitRule),
    ).toThrow(RangeError);
  });
});

describe("calculateVisitProfit with rules on the lines", () => {
  it("costs a two-service visit under two rules", () => {
    const result = calculateVisitProfit({
      currency: "MDL",
      lines: [
        { kind: "service", priceMinor: 50_000, discountMinor: 0, commissionTerms: visitRule },
        { kind: "service", priceMinor: 40_000, discountMinor: 0, commissionTerms: flat },
      ],
      commission: visitRule.commission,
      plannedDurationMinutes: 120,
      actualDurationMinutes: null,
    });

    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.commissionMinor).toBe(20_000 + 15_000);
    expect(result.costing.contributionMarginMinor).toBe(90_000 - 35_000);
  });
});
