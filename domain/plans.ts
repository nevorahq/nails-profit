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

/**
 * What a tier opens beyond «Старт», named by what the studio would miss. The
 * core — bookings, calendar, clients, the profit of every visit and this
 * month's report — is on every tier and so is not a feature here.
 */
export const planFeatures = [
  /** Reports for any month or span, not only the current month. */
  "full_reports",
  /** Adding to the expense ledger. What is already there stays readable and editable. */
  "expenses",
  /** Importing clients, services and visits from a file or another system. */
  "import",
  /** Reminders and notices to clients by SMS; «Старт» sends email only. */
  "sms",
  /** Inviting colleagues into the workspace with a role. */
  "team",
] as const;
export type PlanFeature = (typeof planFeatures)[number];

const featureFloor: Readonly<Record<PlanFeature, PaidPlanTier>> = {
  full_reports: "solo",
  expenses: "solo",
  import: "solo",
  sms: "solo",
  team: "studio",
};

/** The cheapest tier that opens a feature — what a refusal suggests. */
export function lowestTierFor(feature: PlanFeature): PaidPlanTier {
  return featureFloor[feature];
}

export function planAllows(tier: PlanTier, feature: PlanFeature): boolean {
  return planTiers.indexOf(tier) >= planTiers.indexOf(featureFloor[feature]);
}

/**
 * How many active specialists a tier may have, or `null` for no cap.
 *
 * «Старт» and «Соло» are one person by definition. The team tiers carry an
 * allowance (`planAllowance`) that a studio is meant to extend by buying
 * add-ons, but the checkout cannot sell an add-on yet — so until it can, a
 * team tier is not capped at all rather than capped with no way past it.
 */
export function specialistCap(tier: PlanTier): number | null {
  return tier === "start" || tier === "solo" ? planAllowance[tier].specialists : null;
}

/** How many active locations a tier may have, or `null` for no cap — same reasoning. */
export function locationCap(tier: PlanTier): number | null {
  return tier === "business" ? null : planAllowance[tier].locations;
}

export type PlanSource = "subscription" | "pilot" | "trial" | "free";

export type ResolvedPlan = Readonly<{
  tier: PlanTier;
  /** Why the studio is on that tier — what the settings page says about it. */
  source: PlanSource;
  /**
   * When the free «Студия» ends: the sign-up trial's last moment while
   * `source` is `trial`, the pilots' while it is `pilot` and a date is set.
   */
  trialEndsAt: Date | null;
}>;

/**
 * The tier a studio is on right now, first match wins:
 *
 *   1. a live subscription — `trialing`, `active`, or `past_due` while the
 *      provider retries the card (its dunning, not ours) — at the tier its
 *      price charges for. A price the catalog does not know (an archived
 *      August price, a Lemon Squeezy variant) counts as «Бизнес»: a studio
 *      that pays is never cut down because of a lookup;
 *   2. an active pilot enrollment — «Студия», what the pilot was promised,
 *      until `pilotFreeUntil` when one is set: from then on a pilot studio
 *      pays like everyone else (the founder price is there for it);
 *   3. the first 14 days after the studio was created — «Студия» on trial;
 *   4. otherwise «Старт», free and without end.
 */
export function resolvePlan(input: {
  subscription: { status: "trialing" | "active" | "past_due" | "paused" | "canceled"; tier: PaidPlanTier | null } | null;
  pilotActive: boolean;
  /** The end of the pilots' free «Студия»; `null` keeps it open-ended. */
  pilotFreeUntil?: Date | null;
  organizationCreatedAt: Date;
  now: Date;
}): ResolvedPlan {
  const subscription = input.subscription;
  if (
    subscription &&
    (subscription.status === "trialing" || subscription.status === "active" || subscription.status === "past_due")
  ) {
    return { tier: subscription.tier ?? "business", source: "subscription", trialEndsAt: null };
  }
  if (input.pilotActive && (!input.pilotFreeUntil || input.now < input.pilotFreeUntil)) {
    return { tier: "studio", source: "pilot", trialEndsAt: input.pilotFreeUntil ?? null };
  }

  const trialEndsAt = new Date(input.organizationCreatedAt.getTime() + signupTrial.days * 86_400_000);
  if (input.now < trialEndsAt) return { tier: signupTrial.tier, source: "trial", trialEndsAt };
  return { tier: "start", source: "free", trialEndsAt: null };
}
