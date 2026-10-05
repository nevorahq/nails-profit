import { describe, expect, it } from "vitest";

import { expenseCategories } from "@/domain/expense-categories";
import { categoriesOfClass, expenseClassOf, isMaterialCategory, isOverhead } from "@/domain/expense-classes";

describe("the class of a recorded expense", () => {
  it("counts materials and consumables as costs in a month counted by purchases", () => {
    expect(expenseClassOf("materials")).toBe("overhead");
    expect(expenseClassOf("consumables", "purchases")).toBe("overhead");
    expect(isOverhead("materials", "purchases")).toBe(true);
  });

  it("counts them as cash only in a month counted per service, where visits already took them", () => {
    expect(expenseClassOf("materials", "per_service")).toBe("cash_only");
    expect(expenseClassOf("consumables", "per_service")).toBe("cash_only");
    expect(isOverhead("consumables", "per_service")).toBe(false);
  });

  it("leaves every other category where it was, whatever the mode", () => {
    for (const category of expenseCategories.filter((category) => !isMaterialCategory(category))) {
      expect(expenseClassOf(category, "per_service")).toBe(expenseClassOf(category, "purchases"));
    }
    expect(expenseClassOf("payroll", "purchases")).toBe("cash_only");
    expect(expenseClassOf("rent", "per_service")).toBe("overhead");
  });

  it("groups the categories by the class of the month", () => {
    expect(categoriesOfClass("cash_only")).toEqual(["payroll"]);
    expect(categoriesOfClass("cash_only", "per_service")).toEqual(
      expect.arrayContaining(["payroll", "materials", "consumables"]),
    );
  });
});
