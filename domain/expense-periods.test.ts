import { describe, expect, it } from "vitest";

import {
  byCategory,
  expensesForMonth,
  totalByClass,
  type PeriodExpenseRow,
} from "@/domain/expense-periods";

function row(overrides: Partial<PeriodExpenseRow> & { id: string }): PeriodExpenseRow {
  return {
    name: "Аренда",
    category: "rent",
    amountMinor: 800_00,
    spentOn: "2026-03-05",
    isRecurring: false,
    recurringFrom: null,
    recurringTo: null,
    ...overrides,
  };
}

describe("expensesForMonth", () => {
  it("takes a one-off purchase into the month it was spent in", () => {
    const rows = [
      row({ id: "march", spentOn: "2026-03-31" }),
      row({ id: "april", spentOn: "2026-04-01" }),
    ];

    expect(expensesForMonth(rows, "2026-03").map((line) => line.id)).toEqual(["march"]);
    expect(expensesForMonth(rows, "2026-04").map((line) => line.id)).toEqual(["april"]);
  });

  it("charges a recurring row to every month of its interval", () => {
    const rent = row({
      id: "rent",
      isRecurring: true,
      recurringFrom: "2026-03-15",
      recurringTo: "2026-05-10",
      spentOn: "2026-03-15",
    });

    for (const month of ["2026-03", "2026-04", "2026-05"]) {
      expect(expensesForMonth([rent], month)).toHaveLength(1);
    }
    for (const month of ["2026-02", "2026-06"]) {
      expect(expensesForMonth([rent], month)).toHaveLength(0);
    }
  });

  it("counts the month it started in and the month it ended in, whole", () => {
    // Rent that starts on the 15th is a cost of that month: the business paid
    // it. Anything finer would need a proration the ledger does not record.
    const rent = row({
      id: "rent",
      isRecurring: true,
      recurringFrom: "2026-03-31",
      recurringTo: "2026-05-01",
    });

    expect(expensesForMonth([rent], "2026-03")).toHaveLength(1);
    expect(expensesForMonth([rent], "2026-05")).toHaveLength(1);
  });

  it("runs an open-ended row forever forward and never backward", () => {
    const rent = row({ id: "rent", isRecurring: true, recurringFrom: "2026-03-01", recurringTo: null });

    expect(expensesForMonth([rent], "2029-12")).toHaveLength(1);
    expect(expensesForMonth([rent], "2026-02")).toHaveLength(0);
  });

  /*
   * The reason recurring rows are intervals rather than twelve copies: raising
   * the rent in June must leave January alone. The old row is closed, a new one
   * opens, and every month keeps the amount that was true in it.
   */
  it("keeps each month on the amount that was true in it when the rent changes", () => {
    const rows = [
      row({ id: "old", amountMinor: 800_00, isRecurring: true, recurringFrom: "2026-01-01", recurringTo: "2026-05-31" }),
      row({ id: "new", amountMinor: 950_00, isRecurring: true, recurringFrom: "2026-06-01", recurringTo: null }),
    ];

    expect(totalByClass(expensesForMonth(rows, "2026-01")).overhead).toBe(800_00);
    expect(totalByClass(expensesForMonth(rows, "2026-06")).overhead).toBe(950_00);
    // And never both at once in the month they meet.
    expect(expensesForMonth(rows, "2026-05")).toHaveLength(1);
    expect(expensesForMonth(rows, "2026-06")).toHaveLength(1);
  });

  it("ignores a recurring row with no start rather than charging all of history", () => {
    const broken = row({ id: "broken", isRecurring: true, recurringFrom: null });

    expect(expensesForMonth([broken], "2026-03")).toHaveLength(0);
    expect(expensesForMonth([broken], "1999-01")).toHaveLength(0);
  });
});

describe("totals", () => {
  const march = [
    row({ id: "rent", category: "rent", amountMinor: 800_00 }),
    row({ id: "ads", category: "marketing", amountMinor: 150_00 }),
    row({ id: "gel", category: "materials", amountMinor: 500_00 }),
    row({ id: "wage", category: "payroll", amountMinor: 400_00 }),
  ];

  it("keeps what a visit already counted out of the overhead", () => {
    const totals = totalByClass(expensesForMonth(march, "2026-03"));

    // Materials sit on the overhead side now: nothing counts their cost a
    // second time, so the month they were bought in is the month they cost.
    expect(totals.overhead).toBe(1_450_00);
    expect(totals.cash_only).toBe(400_00);
  });

  it("lists only the categories that occurred", () => {
    const totals = byCategory(expensesForMonth(march, "2026-03"));

    expect(totals).toEqual({ rent: 800_00, marketing: 150_00, materials: 500_00, payroll: 400_00 });
    expect(Object.keys(totals)).not.toContain("transport");
  });

  it("answers zero for a month with nothing in it", () => {
    const totals = totalByClass(expensesForMonth(march, "2026-09"));

    expect(totals).toEqual({ overhead: 0, cash_only: 0 });
  });
});
