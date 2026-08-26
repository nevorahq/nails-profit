import { describe, expect, it } from "vitest";

import { selectCommissionRule, toCommission, type CommissionRuleRow } from "@/domain/commission";

const SERVICE = "service-1";
const OTHER = "service-2";

function rule(overrides: Partial<CommissionRuleRow> & { id: string }): CommissionRuleRow {
  return {
    serviceId: null,
    type: "percentage",
    basisPoints: 4_000,
    fixedAmountMinor: null,
    activeFrom: new Date("2026-01-01T00:00:00Z"),
    activeTo: null,
    ...overrides,
  };
}

const now = new Date("2026-08-05T12:00:00Z");

describe("selectCommissionRule", () => {
  it("returns null when the specialist has no rule", () => {
    expect(selectCommissionRule([], SERVICE, now)).toBeNull();
  });

  it("uses the specialist default when there is no exception", () => {
    expect(selectCommissionRule([rule({ id: "default" })], SERVICE, now)?.id).toBe("default");
  });

  it("prefers a per-service exception over the default", () => {
    const rules = [rule({ id: "default" }), rule({ id: "exception", serviceId: SERVICE })];
    expect(selectCommissionRule(rules, SERVICE, now)?.id).toBe("exception");
  });

  it("ignores an exception written for another service", () => {
    const rules = [rule({ id: "default" }), rule({ id: "other", serviceId: OTHER })];
    expect(selectCommissionRule(rules, SERVICE, now)?.id).toBe("default");
  });

  it("prefers the exception even when the default is newer", () => {
    const rules = [
      rule({ id: "default", activeFrom: new Date("2026-07-01T00:00:00Z") }),
      rule({ id: "exception", serviceId: SERVICE, activeFrom: new Date("2026-02-01T00:00:00Z") }),
    ];
    expect(selectCommissionRule(rules, SERVICE, now)?.id).toBe("exception");
  });

  it("takes the most recently effective rule among equals", () => {
    const rules = [
      rule({ id: "old", activeFrom: new Date("2026-01-01T00:00:00Z") }),
      rule({ id: "new", activeFrom: new Date("2026-06-01T00:00:00Z") }),
    ];
    expect(selectCommissionRule(rules, SERVICE, now)?.id).toBe("new");
  });

  it("ignores rules that are not yet in force", () => {
    const rules = [
      rule({ id: "current" }),
      rule({ id: "future", activeFrom: new Date("2026-12-01T00:00:00Z") }),
    ];
    expect(selectCommissionRule(rules, SERVICE, now)?.id).toBe("current");
  });

  it("ignores rules that have already ended", () => {
    const rules = [rule({ id: "ended", activeTo: new Date("2026-03-01T00:00:00Z") })];
    expect(selectCommissionRule(rules, SERVICE, now)).toBeNull();
  });

  it("does not rewrite history: an older date resolves to the older rule", () => {
    // CST-009: changing a rule must leave completed visits alone, which only
    // works if asking about the past still answers with the past.
    const rules = [
      rule({
        id: "old",
        basisPoints: 3_000,
        activeFrom: new Date("2026-01-01T00:00:00Z"),
        activeTo: new Date("2026-06-01T00:00:00Z"),
      }),
      rule({ id: "new", basisPoints: 4_000, activeFrom: new Date("2026-06-01T00:00:00Z") }),
    ];

    expect(selectCommissionRule(rules, SERVICE, new Date("2026-03-01T00:00:00Z"))?.id).toBe("old");
    expect(selectCommissionRule(rules, SERVICE, now)?.id).toBe("new");
  });

  it("treats the activeTo instant as already ended", () => {
    const rules = [rule({ id: "ends-now", activeTo: now })];
    expect(selectCommissionRule(rules, SERVICE, now)).toBeNull();
  });
});

describe("toCommission", () => {
  it("maps each stored shape onto the engine's input", () => {
    expect(toCommission(rule({ id: "p", type: "percentage", basisPoints: 4_000 }))).toEqual({
      type: "percentage",
      basisPoints: 4_000,
    });
    expect(
      toCommission(
        rule({ id: "f", type: "fixed", basisPoints: null, fixedAmountMinor: 12_000 }),
      ),
    ).toEqual({ type: "fixed", amountMinor: 12_000 });
    expect(
      toCommission(rule({ id: "h", type: "hybrid", basisPoints: 2_000, fixedAmountMinor: 10_000 })),
    ).toEqual({ type: "hybrid", basisPoints: 2_000, amountMinor: 10_000 });
  });

  it("refuses a rule whose shape contradicts its type", () => {
    expect(() => toCommission(rule({ id: "bad", type: "fixed", fixedAmountMinor: null }))).toThrow();
    expect(() => toCommission(rule({ id: "bad", type: "percentage", basisPoints: null }))).toThrow();
    // Half a hybrid is not a cheaper hybrid — it is a rule nobody agreed to.
    expect(() =>
      toCommission(rule({ id: "bad", type: "hybrid", basisPoints: 2_000, fixedAmountMinor: null })),
    ).toThrow();
    expect(() =>
      toCommission(rule({ id: "bad", type: "hybrid", basisPoints: null, fixedAmountMinor: 10_000 })),
    ).toThrow();
  });
});
