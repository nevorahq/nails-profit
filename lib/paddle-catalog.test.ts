import { describe, expect, it } from "vitest";

import { billingPeriods, paidPlanTiers } from "@/domain/plans";
import { paddlePlanPrices, planForPaddlePrice } from "@/lib/paddle-catalog";

describe("paddle catalog", () => {
  it("has a distinct price for every tier and period, and no id shared between environments", () => {
    const ids = (["sandbox", "live"] as const).flatMap((environment) => {
      const prices = paddlePlanPrices(environment);
      return paidPlanTiers.flatMap((tier) => billingPeriods.map((period) => prices[tier][period]));
    });
    expect(ids.every((id) => /^pri_[a-z\d]{26}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads a price id back as its tier and period", () => {
    const id = paddlePlanPrices("sandbox").studio[12];
    expect(planForPaddlePrice("sandbox", id)).toEqual({ tier: "studio", period: 12 });
  });

  it("knows nothing of a price outside the grid", () => {
    // The archived August «Соло» monthly price.
    expect(planForPaddlePrice("sandbox", "pri_01m1f59x9xj6dqjr83k9ch37gq")).toBeNull();
  });

  it("reads each environment's ids against its own catalog only", () => {
    expect(planForPaddlePrice("live", paddlePlanPrices("live").business[12])).toEqual({ tier: "business", period: 12 });
    expect(planForPaddlePrice("live", paddlePlanPrices("sandbox").solo[1])).toBeNull();
    // The August live «Соло» monthly, still active until the new build is out.
    expect(planForPaddlePrice("live", "pri_01m1faf7x95662ycy6pmfze4nb")).toBeNull();
  });
});
