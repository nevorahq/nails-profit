import { describe, expect, it } from "vitest";

import {
  laborCostTotals,
  monthlyLaborCostMinor,
  selectLaborRules,
  type LaborCostRuleRow,
} from "@/domain/labor-cost";

function rule(overrides: Partial<LaborCostRuleRow> & { id: string }): LaborCostRuleRow {
  return {
    recipient: "specialist",
    specialistId: "master-a",
    label: "Оклад",
    basis: "fixed_monthly",
    amountMinor: 8_000_00,
    basisPoints: null,
    payrollTaxBasisPoints: 0,
    activeFrom: new Date("2026-01-01T00:00:00.000Z"),
    activeTo: null,
    ...overrides,
  };
}

describe("selectLaborRules", () => {
  it("takes a rule from the month it started in onwards", () => {
    const salary = rule({ id: "salary", activeFrom: new Date("2026-03-20T00:00:00.000Z") });

    expect(selectLaborRules([salary], "2026-02")).toHaveLength(0);
    // Agreed on the 20th and still a March cost: the month is the unit.
    expect(selectLaborRules([salary], "2026-03")).toHaveLength(1);
    expect(selectLaborRules([salary], "2029-11")).toHaveLength(1);
  });

  it("keeps the month it ended in and drops the next", () => {
    const salary = rule({ id: "salary", activeTo: new Date("2026-08-10T00:00:00.000Z") });

    expect(selectLaborRules([salary], "2026-08")).toHaveLength(1);
    expect(selectLaborRules([salary], "2026-09")).toHaveLength(0);
  });

  /*
   * The arithmetic this function exists to prevent. A raise is a new row, not
   * an edit — otherwise January stops reporting January's salary — so two rows
   * can match one person, and paying both would be a quiet doubling that looks
   * entirely plausible on screen.
   */
  it("pays one salary per person when a raise leaves two rows behind", () => {
    const rules = [
      rule({
        id: "old",
        amountMinor: 8_000_00,
        activeFrom: new Date("2026-01-01T00:00:00.000Z"),
        activeTo: new Date("2026-05-31T00:00:00.000Z"),
      }),
      rule({ id: "new", amountMinor: 9_500_00, activeFrom: new Date("2026-06-01T00:00:00.000Z") }),
    ];

    expect(selectLaborRules(rules, "2026-03").map((row) => row.id)).toEqual(["old"]);
    expect(selectLaborRules(rules, "2026-07").map((row) => row.id)).toEqual(["new"]);
  });

  it("takes the newest when two rows overlap outright", () => {
    const rules = [
      rule({ id: "older", amountMinor: 8_000_00, activeFrom: new Date("2026-01-01T00:00:00.000Z") }),
      rule({ id: "newer", amountMinor: 9_000_00, activeFrom: new Date("2026-04-01T00:00:00.000Z") }),
    ];

    expect(selectLaborRules(rules, "2026-07").map((row) => row.id)).toEqual(["newer"]);
  });

  it("keeps different people apart", () => {
    const rules = [
      rule({ id: "a", specialistId: "master-a" }),
      rule({ id: "b", specialistId: "master-b" }),
      rule({ id: "owner", recipient: "owner", specialistId: null }),
    ];

    expect(selectLaborRules(rules, "2026-07")).toHaveLength(3);
  });

  it("keeps one owner rule, however many were written", () => {
    const rules = [
      rule({ id: "old", recipient: "owner", specialistId: null, activeFrom: new Date("2026-01-01T00:00:00.000Z") }),
      rule({ id: "new", recipient: "owner", specialistId: null, activeFrom: new Date("2026-05-01T00:00:00.000Z") }),
    ];

    expect(selectLaborRules(rules, "2026-07").map((row) => row.id)).toEqual(["new"]);
  });
});

describe("monthlyLaborCostMinor", () => {
  it("charges a fixed salary whatever the month earned", () => {
    const salary = rule({ id: "salary", amountMinor: 8_000_00 });

    expect(monthlyLaborCostMinor(salary, { revenueMinor: 0 })).toBe(8_000_00);
    expect(monthlyLaborCostMinor(salary, { revenueMinor: 90_000_00 })).toBe(8_000_00);
  });

  it("takes a share of the revenue when that is the arrangement", () => {
    const share = rule({ id: "share", basis: "percent_revenue", amountMinor: null, basisPoints: 1_500 });

    expect(monthlyLaborCostMinor(share, { revenueMinor: 40_000_00 })).toBe(6_000_00);
    // Nothing earned, nothing owed — and no division by zero on the way.
    expect(monthlyLaborCostMinor(share, { revenueMinor: 0 })).toBe(0);
  });

  it("adds the employer's contributions on top of the wage", () => {
    const salary = rule({ id: "salary", amountMinor: 10_000_00, payrollTaxBasisPoints: 2_400 });

    expect(monthlyLaborCostMinor(salary, { revenueMinor: 0 })).toBe(12_400_00);
  });

  it("rounds the wage before taxing it, so the printed lines add up", () => {
    // 15% of 3333.33 is 499.9995 → 500.00, and 10% of that is exactly 50.00.
    const share = rule({
      id: "share",
      basis: "percent_revenue",
      amountMinor: null,
      basisPoints: 1_500,
      payrollTaxBasisPoints: 1_000,
    });

    expect(monthlyLaborCostMinor(share, { revenueMinor: 333_333 })).toBe(50_000 + 5_000);
  });
});

describe("laborCostTotals", () => {
  it("keeps the salaried and the owner on separate lines", () => {
    const rules = [
      rule({ id: "a", specialistId: "master-a", amountMinor: 8_000_00 }),
      rule({ id: "b", specialistId: "master-b", amountMinor: 7_000_00 }),
      rule({ id: "owner", recipient: "owner", specialistId: null, amountMinor: 15_000_00 }),
    ];

    expect(laborCostTotals(rules, { revenueMinor: 0 })).toEqual({
      salariedMinor: 15_000_00,
      ownerMinor: 15_000_00,
    });
  });

  /*
   * Unknown is not zero — the invariant the whole engine rests on. An owner who
   * has not said what their work is worth has an unanswered question, and
   * answering it with zero would turn their unpaid hours straight into economic
   * profit.
   */
  it("leaves the owner's wage unknown rather than free", () => {
    const totals = laborCostTotals([rule({ id: "a" })], { revenueMinor: 50_000_00 });

    expect(totals.salariedMinor).toBe(8_000_00);
    expect(totals.ownerMinor).toBeNull();
  });

  it("answers nothing owed for a month with no rules at all", () => {
    expect(laborCostTotals([], { revenueMinor: 50_000_00 })).toEqual({
      salariedMinor: 0,
      ownerMinor: null,
    });
  });

  it("reads an owner rule of zero as zero, because it was stated", () => {
    const stated = rule({ id: "owner", recipient: "owner", specialistId: null, amountMinor: 0 });

    expect(laborCostTotals([stated], { revenueMinor: 0 }).ownerMinor).toBe(0);
  });
});
