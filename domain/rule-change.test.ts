import { describe, expect, it } from "vitest";

import { selectCommissionRule } from "@/domain/commission";
import { planRuleChange, RULE_CHANGE_REFUSALS } from "@/domain/rule-change";
import { selectTaxRates } from "@/domain/tax-rules";

const ZONE = "Europe/Chisinau";
// 14:00 in Chișinău (UTC+3 until the end of October).
const NOW = new Date("2026-10-05T11:00:00.000Z");

describe("planRuleChange", () => {
  const current = [{ id: "old", activeFrom: new Date("2026-01-01T00:00:00.000Z") }];

  it("changes now when no day is given, closing the old rule at the same instant", () => {
    const plan = planRuleChange({ current, now: NOW, timezone: ZONE });

    expect(plan).toEqual({ ok: true, close: { ids: ["old"], activeTo: NOW }, open: { activeFrom: NOW } });
  });

  it("changes now, not at midnight, when the day is today", () => {
    // Midnight would reach back over visits already closed this morning.
    const plan = planRuleChange({ current, effectiveDate: "2026-10-05", now: NOW, timezone: ZONE });

    expect(plan.ok && plan.open.activeFrom).toEqual(NOW);
  });

  it("starts a later day at that day's midnight in the studio's zone", () => {
    const plan = planRuleChange({ current, effectiveDate: "2026-10-10", now: NOW, timezone: ZONE });

    expect(plan).toEqual({
      ok: true,
      close: { ids: ["old"], activeTo: new Date("2026-10-09T21:00:00.000Z") },
      open: { activeFrom: new Date("2026-10-09T21:00:00.000Z") },
    });
  });

  it("refuses a day that has passed", () => {
    expect(planRuleChange({ current, effectiveDate: "2026-10-04", now: NOW, timezone: ZONE })).toEqual({
      ok: false,
      reason: "in_the_past",
    });
  });

  it("reads «today» by the studio's clock, not by UTC", () => {
    // 01:30 on the 6th in Chișinău is still the 5th in UTC.
    const lateEvening = new Date("2026-10-05T22:30:00.000Z");

    expect(planRuleChange({ current, effectiveDate: "2026-10-05", now: lateEvening, timezone: ZONE })).toEqual({
      ok: false,
      reason: "in_the_past",
    });
    expect(
      planRuleChange({ current, effectiveDate: "2026-10-06", now: lateEvening, timezone: ZONE }),
    ).toMatchObject({ ok: true, open: { activeFrom: lateEvening } });
  });

  it("refuses something that is not a calendar day", () => {
    expect(planRuleChange({ current, effectiveDate: "2026-02-30", now: NOW, timezone: ZONE })).toEqual({
      ok: false,
      reason: "invalid_date",
    });
    expect(planRuleChange({ current, effectiveDate: "next week", now: NOW, timezone: ZONE })).toEqual({
      ok: false,
      reason: "invalid_date",
    });
  });

  it("refuses to start before, or at, a rule already scheduled", () => {
    const scheduled = [{ id: "next-week", activeFrom: new Date("2026-10-11T21:00:00.000Z") }];

    expect(planRuleChange({ current: scheduled, effectiveDate: "2026-10-08", now: NOW, timezone: ZONE })).toEqual({
      ok: false,
      reason: "not_after_current",
    });
    expect(planRuleChange({ current: scheduled, effectiveDate: "2026-10-12", now: NOW, timezone: ZONE })).toEqual({
      ok: false,
      reason: "not_after_current",
    });
    expect(
      planRuleChange({ current: scheduled, effectiveDate: "2026-10-13", now: NOW, timezone: ZONE }),
    ).toMatchObject({ ok: true, close: { ids: ["next-week"] } });
  });

  it("opens a first rule with nothing to close", () => {
    expect(planRuleChange({ current: [], now: NOW, timezone: ZONE })).toEqual({
      ok: true,
      close: { ids: [], activeTo: NOW },
      open: { activeFrom: NOW },
    });
  });

  it("names every refusal for the API", () => {
    expect(Object.keys(RULE_CHANGE_REFUSALS).sort()).toEqual(["in_the_past", "invalid_date", "not_after_current"]);
  });
});

describe("a rule changed from a date", () => {
  const from = new Date("2026-01-01T00:00:00.000Z");
  const plan = planRuleChange({
    current: [{ id: "old", activeFrom: from }],
    effectiveDate: "2026-10-10",
    now: NOW,
    timezone: ZONE,
  });
  if (!plan.ok) throw new Error("the change was refused");
  const switchover = plan.open.activeFrom;
  const justBefore = new Date(switchover.getTime() - 1);

  it("leaves no instant with no rule and none with two — commission", () => {
    const rules = [
      { id: "old", serviceId: null, type: "percentage" as const, basisPoints: 4_000, fixedAmountMinor: null, activeFrom: from, activeTo: plan.close.activeTo },
      { id: "new", serviceId: null, type: "percentage" as const, basisPoints: 3_000, fixedAmountMinor: null, activeFrom: switchover, activeTo: null },
    ];

    expect(selectCommissionRule(rules, "service", justBefore)?.id).toBe("old");
    expect(selectCommissionRule(rules, "service", switchover)?.id).toBe("new");
    // Exactly one rule is open at every instant: the old one's end is the new one's start.
    const openAt = (at: Date) =>
      rules.filter((rule) => rule.activeFrom <= at && (rule.activeTo === null || rule.activeTo > at)).length;
    expect([openAt(justBefore), openAt(switchover)]).toEqual([1, 1]);
  });

  it("leaves no instant with no rate and none with two — taxes", () => {
    const rules = [
      { kind: "vat" as const, basisPoints: 2_000, remittable: true, activeFrom: from, activeTo: plan.close.activeTo },
      { kind: "vat" as const, basisPoints: 800, remittable: true, activeFrom: switchover, activeTo: null },
    ];

    expect(selectTaxRates(rules, justBefore).vatBasisPoints).toBe(2_000);
    expect(selectTaxRates(rules, switchover).vatBasisPoints).toBe(800);
  });
});
