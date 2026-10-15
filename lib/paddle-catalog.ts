import type { BillingPeriod, PaidPlanTier } from "@/domain/plans";

/**
 * Which Paddle price charges which tier for which period. Price ids are
 * public (they ship to the browser with every checkout), so they live here
 * rather than in nine environment variables. The amounts behind them must
 * match `domain/plans.ts`; `docs/paddle-migration.md` keeps the record of
 * both environments.
 */
type PlanPrices = Readonly<Record<PaidPlanTier, Readonly<Record<BillingPeriod, string>>>>;

const catalogs: Readonly<Record<"sandbox" | "live", PlanPrices>> = {
  sandbox: {
    solo: {
      1: "pri_01m4zfy4kmaqvb7yeehndg6dg5",
      6: "pri_01m4zfy4ssqw1e5cxjhq0txbnh",
      12: "pri_01m4zfy4z47ept293pzaza7v72",
    },
    studio: {
      1: "pri_01m4zfy545j0c13nwewzq7apc6",
      6: "pri_01m4zfy599jm1neh74ysqhc8mf",
      12: "pri_01m4zfy5eacyjd4jndvqy3t3xk",
    },
    business: {
      1: "pri_01m4zfy5kebm2fdmt1bnqzcjan",
      6: "pri_01m4zfy5rrqxats5ypg6n8n0r2",
      12: "pri_01m4zfy5y2zxfe90gdreqc5r55",
    },
  },
  live: {
    solo: {
      1: "pri_01m4zt661j5enyv3483bm76yfr",
      6: "pri_01m4zt6672aecd2pbdv7xssgms",
      12: "pri_01m4zt66c30cgggs29gcf3c1m7",
    },
    studio: {
      1: "pri_01m4zt66h1btny5bxrqzre9ydc",
      6: "pri_01m4zt66p2gkny9k7zp0q1r0pr",
      12: "pri_01m4zt66v5kcczg72bj6kcgqxh",
    },
    business: {
      1: "pri_01m4zt6705t57dhw9b6nfvvp7e",
      6: "pri_01m4zt675c905bj05de80tz9sr",
      12: "pri_01m4zt67and6cbxyn5zp15n5x0",
    },
  },
};

export type PaddleEnvironment = keyof typeof catalogs;

export function paddlePlanPrices(environment: PaddleEnvironment): PlanPrices {
  return catalogs[environment];
}

/**
 * The tier and period a price id charges for — what a webhook's
 * `providerPriceId` means. `null` for a price outside the grid, such as one
 * of the archived August prices.
 */
export function planForPaddlePrice(
  environment: PaddleEnvironment,
  priceId: string,
): { tier: PaidPlanTier; period: BillingPeriod } | null {
  for (const [tier, periods] of Object.entries(catalogs[environment]) as [PaidPlanTier, Record<BillingPeriod, string>][]) {
    for (const [period, id] of Object.entries(periods)) {
      if (id === priceId) return { tier, period: Number(period) as BillingPeriod };
    }
  }
  return null;
}
