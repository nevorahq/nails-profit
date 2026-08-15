import { describe, expect, it } from "vitest";

import { expenseCategories, isExpenseCategory } from "@/domain/expense-categories";
import { dictionaries } from "@/i18n/dictionary";
import { supportedLocales } from "@/i18n/messages";

describe("expense categories", () => {
  it("has no duplicates", () => {
    expect(new Set(expenseCategories).size).toBe(expenseCategories.length);
  });

  it("recognizes its own members and nothing else", () => {
    expect(isExpenseCategory("rent")).toBe(true);
    expect(isExpenseCategory("Rent")).toBe(false);
    expect(isExpenseCategory("аренда")).toBe(false);
  });

  /*
   * The other dictionary gaps are compile errors — `ro` and `en` are typed as
   * complete records over `ru`'s keys. A category added to the array without a
   * key added to `ru` is the one gap the type system cannot see, so it is
   * checked here instead.
   */
  it("is translated in every locale", () => {
    for (const locale of supportedLocales) {
      for (const category of expenseCategories) {
        expect(dictionaries[locale][`expenses.category.${category}`], `${locale}/${category}`).toBeTypeOf(
          "string",
        );
      }
    }
  });
});
