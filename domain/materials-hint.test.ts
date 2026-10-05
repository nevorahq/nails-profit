import { describe, expect, it } from "vitest";

import type { PeriodExpenseRow } from "@/domain/expense-periods";
import { materialsHint, materialsHintMonths } from "@/domain/materials-hint";

type Row = PeriodExpenseRow & { currency: string };

function purchase(overrides: Partial<Row> & { id: string }): Row {
  return {
    name: "Гель",
    category: "materials",
    amountMinor: 30_000,
    spentOn: "2026-08-10",
    isRecurring: false,
    recurringFrom: null,
    recurringTo: null,
    currency: "MDL",
    ...overrides,
  };
}

const months = materialsHintMonths("2026-10");

describe("the months the hint looks back over", () => {
  it("are the three full months before this one, across a year's end", () => {
    expect(months).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(materialsHintMonths("2027-02")).toEqual(["2026-11", "2026-12", "2027-01"]);
  });
});

describe("the hint from purchases", () => {
  const expenses = [
    purchase({ id: "gel", amountMinor: 60_000, spentOn: "2026-07-03" }),
    purchase({ id: "gloves", category: "consumables", amountMinor: 20_000, spentOn: "2026-09-15" }),
    // Not a material, and this month rather than a full one.
    purchase({ id: "rent", category: "rent", amountMinor: 900_000, spentOn: "2026-08-01" }),
    purchase({ id: "today", amountMinor: 99_000, spentOn: "2026-10-02" }),
  ];

  it("spreads materials and consumables over the visits closed in the same months", () => {
    expect(materialsHint({ expenses, closedVisits: 40, months, currency: "MDL" })).toBe(2_000);
  });

  it("counts a recurring purchase once in every month it ran", () => {
    const monthly = purchase({
      id: "box",
      amountMinor: 10_000,
      isRecurring: true,
      spentOn: "2026-01-05",
      recurringFrom: "2026-01-05",
    });
    expect(materialsHint({ expenses: [monthly], closedVisits: 20, months, currency: "MDL" })).toBe(1_500);
  });

  it("is withheld with fewer than twenty visits, and with none", () => {
    expect(materialsHint({ expenses, closedVisits: 19, months, currency: "MDL" })).toBeNull();
    expect(materialsHint({ expenses, closedVisits: 0, months, currency: "MDL" })).toBeNull();
  });

  it("is withheld when nothing was bought", () => {
    expect(materialsHint({ expenses: [], closedVisits: 50, months, currency: "MDL" })).toBeNull();
  });

  it("leaves purchases in another currency out rather than converting them", () => {
    const euro = [purchase({ id: "eur", amountMinor: 50_000, currency: "EUR" })];
    expect(materialsHint({ expenses: euro, closedVisits: 50, months, currency: "MDL" })).toBeNull();
    expect(
      materialsHint({ expenses: [...expenses, ...euro], closedVisits: 40, months, currency: "MDL" }),
    ).toBe(2_000);
  });
});
