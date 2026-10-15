import { describe, expect, it } from "vitest";

import {
  billingPeriods,
  effectiveMonthlyPriceMinor,
  isBillingPeriod,
  isPaidPlanTier,
  locationCap,
  lowestTierFor,
  paidPlanTiers,
  planAllows,
  periodPriceMinor,
  periodSavingPercent,
  resolvePlan,
  specialistCap,
} from "@/domain/plans";

describe("plan prices", () => {
  it("charges the approved monthly prices", () => {
    expect(periodPriceMinor("start", 1)).toBe(0);
    expect(periodPriceMinor("solo", 1)).toBe(900);
    expect(periodPriceMinor("studio", 1)).toBe(1_900);
    expect(periodPriceMinor("business", 1)).toBe(3_900);
  });

  it("charges five months for six and nine for twelve", () => {
    expect(periodPriceMinor("solo", 6)).toBe(4_500);
    expect(periodPriceMinor("studio", 12)).toBe(17_100);
    expect(periodSavingPercent(1)).toBe(0);
    expect(periodSavingPercent(6)).toBe(17);
    expect(periodSavingPercent(12)).toBe(25);
  });

  it("rounds the month of a prepay to the cent", () => {
    expect(effectiveMonthlyPriceMinor("solo", 6)).toBe(750);
    expect(effectiveMonthlyPriceMinor("studio", 6)).toBe(1_583);
    expect(effectiveMonthlyPriceMinor("business", 12)).toBe(2_925);
  });

  // A longer prepay must never cost more than repeating a shorter one, or the
  // rational studio buys the short one twice (the August €319 mistake).
  it("never makes a longer period dearer than repeating a shorter one", () => {
    for (const tier of paidPlanTiers) {
      for (const short of billingPeriods) {
        for (const long of billingPeriods) {
          if (long <= short || long % short !== 0) continue;
          expect(periodPriceMinor(tier, long)).toBeLessThan(periodPriceMinor(tier, short) * (long / short));
          expect(effectiveMonthlyPriceMinor(tier, long)).toBeLessThan(effectiveMonthlyPriceMinor(tier, short));
        }
      }
    }
  });
});

describe("plan guards", () => {
  it("accepts only paid tiers", () => {
    expect(isPaidPlanTier("studio")).toBe(true);
    expect(isPaidPlanTier("start")).toBe(false);
    expect(isPaidPlanTier(3)).toBe(false);
  });

  it("accepts only the offered periods", () => {
    expect(isBillingPeriod(12)).toBe(true);
    expect(isBillingPeriod(3)).toBe(false);
    expect(isBillingPeriod("6")).toBe(false);
  });
});

describe("plan features", () => {
  it("keeps paid features off Start and opens them from their floor up", () => {
    expect(planAllows("start", "full_reports")).toBe(false);
    expect(planAllows("solo", "full_reports")).toBe(true);
    expect(planAllows("solo", "team")).toBe(false);
    expect(planAllows("studio", "team")).toBe(true);
    expect(planAllows("business", "sms")).toBe(true);
    expect(lowestTierFor("team")).toBe("studio");
    expect(lowestTierFor("expenses")).toBe("solo");
  });

  it("caps one-person tiers at one specialist and leaves team tiers uncapped until add-ons sell", () => {
    expect(specialistCap("start")).toBe(1);
    expect(specialistCap("solo")).toBe(1);
    expect(specialistCap("studio")).toBeNull();
    expect(specialistCap("business")).toBeNull();
  });

  it("allows a second location only on Business", () => {
    expect(locationCap("start")).toBe(1);
    expect(locationCap("studio")).toBe(1);
    expect(locationCap("business")).toBeNull();
  });
});

describe("resolvePlan", () => {
  const created = new Date("2026-10-01T10:00:00Z");
  const base = { subscription: null, pilotActive: false, organizationCreatedAt: created };

  it("gives a new studio 14 days of Studio, then Start", () => {
    const during = resolvePlan({ ...base, now: new Date("2026-10-15T09:59:59Z") });
    expect(during).toEqual({ tier: "studio", source: "trial", trialEndsAt: new Date("2026-10-15T10:00:00Z") });
    expect(resolvePlan({ ...base, now: new Date("2026-10-15T10:00:00Z") })).toEqual({
      tier: "start",
      source: "free",
      trialEndsAt: null,
    });
  });

  it("puts an active pilot on Studio after its trial", () => {
    expect(resolvePlan({ ...base, pilotActive: true, now: new Date("2026-12-01T00:00:00Z") })).toMatchObject({
      tier: "studio",
      source: "pilot",
    });
  });

  it("ends the pilots' free Studio on the date set, after which a pilot is on Start", () => {
    const pilotFreeUntil = new Date("2027-02-01T00:00:00Z");
    const pilot = { ...base, pilotActive: true, pilotFreeUntil };
    expect(resolvePlan({ ...pilot, now: new Date("2027-01-31T23:59:59Z") })).toEqual({
      tier: "studio",
      source: "pilot",
      trialEndsAt: pilotFreeUntil,
    });
    expect(resolvePlan({ ...pilot, now: pilotFreeUntil })).toMatchObject({ tier: "start", source: "free" });
    expect(
      resolvePlan({ ...pilot, subscription: { status: "active", tier: "studio" }, now: pilotFreeUntil }),
    ).toMatchObject({ tier: "studio", source: "subscription" });
  });

  it("follows a live subscription's tier, including while a payment is retried", () => {
    for (const status of ["trialing", "active", "past_due"] as const) {
      expect(
        resolvePlan({ ...base, subscription: { status, tier: "solo" }, now: new Date("2027-01-01T00:00:00Z") }),
      ).toEqual({ tier: "solo", source: "subscription", trialEndsAt: null });
    }
  });

  it("never cuts a paying studio down for a price the catalog does not know", () => {
    expect(
      resolvePlan({ ...base, subscription: { status: "active", tier: null }, now: new Date("2027-01-01T00:00:00Z") }),
    ).toMatchObject({ tier: "business", source: "subscription" });
  });

  it("drops a paused or canceled subscription back to what the studio would have without it", () => {
    for (const status of ["paused", "canceled"] as const) {
      expect(
        resolvePlan({ ...base, subscription: { status, tier: "business" }, now: new Date("2027-01-01T00:00:00Z") }),
      ).toMatchObject({ tier: "start", source: "free" });
      expect(
        resolvePlan({ ...base, subscription: { status, tier: "business" }, now: new Date("2026-10-02T00:00:00Z") }),
      ).toMatchObject({ tier: "studio", source: "trial" });
    }
  });
});
