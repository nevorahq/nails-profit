import type { BillingPeriod, PaidPlanTier } from "@/domain/plans";

/**
 * Which Paddle price charges which tier for which period. Price ids are
 * public (they ship to the browser with every checkout), so they live here
 * rather than in nine environment variables. The amounts behind them must
 * match `domain/plans.ts`; `docs/paddle-migration.md` keeps the record of
 * both environments.
 *
 * Live is `null` until the live catalog is rebuilt on the October grid — the
 * August prices still there charge the old €17/29/59 — and with no live
 * catalog the settings page draws no checkout at all.
 */
type PlanPrices = Readonly<Record<PaidPlanTier, Readonly<Record<BillingPeriod, string>>>>;

const catalogs: Readonly<Record<"sandbox" | "live", PlanPrices | null>> = {
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
  live: null,
};

export type PaddleEnvironment = keyof typeof catalogs;

export function paddlePlanPrices(environment: PaddleEnvironment): PlanPrices | null {
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
  const prices = catalogs[environment];
  if (!prices) return null;
  for (const [tier, periods] of Object.entries(prices) as [PaidPlanTier, Record<BillingPeriod, string>][]) {
    for (const [period, id] of Object.entries(periods)) {
      if (id === priceId) return { tier, period: Number(period) as BillingPeriod };
    }
  }
  return null;
}
