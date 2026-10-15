import { describe, expect, it } from "vitest";

import {
  billingPeriods,
  effectiveMonthlyPriceMinor,
  isBillingPeriod,
  isPaidPlanTier,
  paidPlanTiers,
  periodPriceMinor,
  periodSavingPercent,
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
