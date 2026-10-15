/**
 * The tariff grid, as approved on 15.10.2026: one price for every country,
 * a free «Старт» to come in on, and prepay for six or twelve months paid as
 * five or nine. Everything that shows or charges a price — the landing page,
 * the subscription block in settings, the Paddle catalog in
 * `lib/paddle-catalog.ts` — reads it from here, so a change of price is one
 * edit plus the matching prices in Paddle.
 *
 * Amounts are euro cents: Paddle bills in EUR, and the studio's own money
 * (MDL) never mixes with what it pays for the tool.
 */

export const planTiers = ["start", "solo", "studio", "business"] as const;
export type PlanTier = (typeof planTiers)[number];

/** The tiers a studio pays for — every one but «Старт». */
export const paidPlanTiers = ["solo", "studio", "business"] as const;
export type PaidPlanTier = (typeof paidPlanTiers)[number];

export const billingPeriods = [1, 6, 12] as const;
export type BillingPeriod = (typeof billingPeriods)[number];

/** How many months a prepaid period charges for: six for five, twelve for nine. */
export const chargedMonths: Readonly<Record<BillingPeriod, number>> = { 1: 1, 6: 5, 12: 9 };

export const monthlyPriceMinor: Readonly<Record<PlanTier, number>> = {
  start: 0,
  solo: 900,
  studio: 1_900,
  business: 3_900,
};

/** What the tier's price already covers; beyond it a studio pays the add-ons below. */
export const planAllowance: Readonly<Record<PlanTier, { specialists: number; locations: number }>> = {
  start: { specialists: 1, locations: 1 },
  solo: { specialists: 1, locations: 1 },
  studio: { specialists: 3, locations: 1 },
  business: { specialists: 8, locations: 3 },
};

/**
 * Monthly price of one more specialist or location past the allowance. Only
 * the team tiers can grow: «Соло» is one person by definition, and a studio
 * that needs a second address has outgrown «Студию».
 */
export const addOnMonthlyPriceMinor = {
  studio: { specialist: 400 },
  business: { specialist: 300, location: 1_000 },
} as const;

/** The full trial a new studio gets on sign-up, before it settles on «Старт». */
export const signupTrial = { tier: "studio", days: 14 } as const satisfies {
  tier: PaidPlanTier;
  days: number;
};

/**
 * The founder price: the first 100 paying studios keep −30% for as long as
 * their subscription runs. Paddle counts the redemptions (discount
 * `FOUNDER30`); these numbers are only what the pages say about it.
 */
export const founderOffer = { percentOff: 30, seats: 100, code: "FOUNDER30" } as const;

/** What a period's prepay costs in total. */
export function periodPriceMinor(tier: PlanTier, period: BillingPeriod): number {
  return monthlyPriceMinor[tier] * chargedMonths[period];
}

/** What a month comes to on that prepay, to the cent. */
export function effectiveMonthlyPriceMinor(tier: PlanTier, period: BillingPeriod): number {
  return Math.round(periodPriceMinor(tier, period) / period);
}

/** The saving against paying month by month, in whole percent: 0, 17 or 25. */
export function periodSavingPercent(period: BillingPeriod): number {
  return Math.round((1 - chargedMonths[period] / period) * 100);
}

export function isPaidPlanTier(value: unknown): value is PaidPlanTier {
  return typeof value === "string" && (paidPlanTiers as readonly string[]).includes(value);
}

export function isBillingPeriod(value: unknown): value is BillingPeriod {
  return typeof value === "number" && (billingPeriods as readonly number[]).includes(value);
}
