import { describe, expect, test } from "vitest";

import { ruleFromForm } from "@/lib/commission-rule";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe("ruleFromForm", () => {
  test("a percentage becomes basis points", () => {
    expect(ruleFromForm(form({ rule_type: "percentage", rule_value: "40" }))).toEqual({
      type: "percentage",
      basis_points: 4_000,
      base: "after_discount",
    });
  });

  test("a fixed amount becomes minor units and carries no base", () => {
    expect(ruleFromForm(form({ rule_type: "fixed", rule_value: "150.50" }))).toEqual({
      type: "fixed",
      fixed_amount_minor: 15_050,
    });
  });

  test("a hybrid needs both halves", () => {
    expect(
      ruleFromForm(form({ rule_type: "hybrid", rule_value: "30", rule_guaranteed: "100" })),
    ).toEqual({ type: "hybrid", basis_points: 3_000, fixed_amount_minor: 10_000, base: "after_discount" });
    expect(ruleFromForm(form({ rule_type: "hybrid", rule_value: "30" }))).toBeNull();
  });

  test("a blank field is an unanswered question, not a zero", () => {
    // `Number("")` is 0 and passes `Number.isFinite`, which used to write a
    // real 0% rule: a master who appeared to work for nothing, with no banner
    // and no refusal to say so.
    expect(ruleFromForm(form({ rule_type: "percentage", rule_value: "" }))).toBeNull();
    expect(ruleFromForm(form({ rule_type: "percentage", rule_value: "   " }))).toBeNull();
    expect(ruleFromForm(form({ rule_type: "percentage" }))).toBeNull();
  });

  test("a zero someone actually typed is a rule — rent and salary are written that way", () => {
    expect(ruleFromForm(form({ rule_type: "percentage", rule_value: "0" }))).toEqual({
      type: "percentage",
      basis_points: 0,
      base: "after_discount",
    });
  });

  test("something that is not a number is refused rather than rounded", () => {
    expect(ruleFromForm(form({ rule_type: "percentage", rule_value: "сорок" }))).toBeNull();
  });

  test("the base is carried through when the form states one", () => {
    expect(
      ruleFromForm(form({ rule_type: "percentage", rule_value: "40", rule_base: "full_price" })),
    ).toMatchObject({ base: "full_price" });
  });
});
