import { describe, expect, test } from "vitest";

import { paidPerVisit, paysNothing, planZeroRule, type DefaultRuleRow } from "@/domain/cooperation";

const now = new Date("2026-10-06T12:00:00Z");

function rule(overrides: Partial<DefaultRuleRow> & Pick<DefaultRuleRow, "id">): DefaultRuleRow {
  return {
    type: "percentage",
    basisPoints: 4000,
    fixedAmountMinor: null,
    activeFrom: new Date("2026-01-01T00:00:00Z"),
    activeTo: null,
    ...overrides,
  };
}

describe("paidPerVisit", () => {
  test("only a percentage master is paid by the visit", () => {
    expect(paidPerVisit("commission")).toBe(true);
    expect(paidPerVisit("rent")).toBe(false);
    expect(paidPerVisit("staff")).toBe(false);
  });
});

describe("paysNothing", () => {
  test("a zero rate, a zero amount and a hybrid of two zeros pay nothing", () => {
    expect(paysNothing({ basisPoints: 0, fixedAmountMinor: null })).toBe(true);
    expect(paysNothing({ basisPoints: null, fixedAmountMinor: 0 })).toBe(true);
    expect(paysNothing({ basisPoints: 0, fixedAmountMinor: 0 })).toBe(true);
  });

  test("anything above zero on either side pays", () => {
    expect(paysNothing({ basisPoints: 1, fixedAmountMinor: null })).toBe(false);
    expect(paysNothing({ basisPoints: 0, fixedAmountMinor: 100 })).toBe(false);
  });
});

describe("planZeroRule", () => {
  test("a master with no rule at all gets a 0% one and nothing is closed", () => {
    expect(planZeroRule([], now)).toEqual({ close: [], open: true });
  });

  test("the 40% in force ends now and a 0% starts", () => {
    expect(planZeroRule([rule({ id: "forty" })], now)).toEqual({
      close: [{ id: "forty", activeTo: now }],
      open: true,
    });
  });

  test("a 0% already in force is kept, so pressing twice writes nothing", () => {
    expect(planZeroRule([rule({ id: "zero", basisPoints: 0 })], now)).toEqual({ close: [], open: false });
  });

  test("a rule scheduled for later is ended at its own start and never applies", () => {
    const start = new Date("2026-11-01T00:00:00Z");
    const plan = planZeroRule(
      [rule({ id: "zero", basisPoints: 0, activeTo: start }), rule({ id: "later", activeFrom: start })],
      now,
    );
    expect(plan).toEqual({ close: [{ id: "later", activeTo: start }], open: false });
  });

  test("a rule in force until a later change is still ended now", () => {
    const start = new Date("2026-11-01T00:00:00Z");
    const plan = planZeroRule([rule({ id: "forty", activeTo: start }), rule({ id: "fifty", activeFrom: start })], now);
    expect(plan).toEqual({
      close: [
        { id: "forty", activeTo: now },
        { id: "fifty", activeTo: start },
      ],
      open: true,
    });
  });

  test("rules already over are no business of the change", () => {
    const plan = planZeroRule([rule({ id: "old", activeTo: new Date("2026-03-01T00:00:00Z") })], now);
    expect(plan).toEqual({ close: [], open: true });
  });
});
