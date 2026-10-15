"use client";

import { useState } from "react";

import { PaddleCheckoutButton } from "@/components/paddle-checkout-button";
import {
  addOnMonthlyPriceMinor,
  billingPeriods,
  founderOffer,
  monthlyPriceMinor,
  paidPlanTiers,
  periodPriceMinor,
  periodSavingPercent,
  type BillingPeriod,
  type PaidPlanTier,
} from "@/domain/plans";
import type { AppLocale } from "@/i18n/messages";
import { writtenRegister, type Register } from "@/i18n/lexicon";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import type { paddlePlanPrices } from "@/lib/paddle-catalog";

type PlanPrices = ReturnType<typeof paddlePlanPrices>;

export function formatEuroMinor(amountMinor: number, locale: AppLocale) {
  return new Intl.NumberFormat(localeTag(locale), {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
  }).format(amountMinor / 100);
}

/**
 * The button's text names what it opens: «Оформить подписку · Студия, €95 за
 * 6 мес.» — the tier and the amount actually charged for the chosen period,
 * from `domain/plans.ts`, the same numbers Paddle holds.
 */
export function checkoutLabel(
  tier: PaidPlanTier,
  period: BillingPeriod,
  locale: AppLocale,
  register: Register = writtenRegister,
) {
  const t = getTranslator(locale, register);
  const price = formatEuroMinor(periodPriceMinor(tier, period), locale);
  const priced =
    period === 1 ? t("billing.price.month", { price }) : t("billing.price.period", { price, months: period });
  return t("billing.startPlan", { plan: `${t(`billing.tier.${tier}`)}, ${priced}` });
}

/**
 * Choosing what to pay for: the tier, the prepay period, then one checkout
 * button for exactly that price. «Студия» monthly is preselected — the tier
 * the 14-day trial runs on, so the studio is offered what it already used.
 */
export function PlanCheckout({
  clientToken,
  environment,
  prices,
  organizationId,
  discountCode,
  locale,
  register = writtenRegister,
}: {
  clientToken: string;
  environment: "sandbox" | "live";
  prices: PlanPrices;
  organizationId: string;
  discountCode: string | null;
  locale: AppLocale;
  register?: Register;
}) {
  const t = getTranslator(locale, register);
  const [tier, setTier] = useState<PaidPlanTier>("studio");
  const [period, setPeriod] = useState<BillingPeriod>(1);

  return (
    <div className="plan-checkout">
      <p className="muted">{t("billing.choose")}</p>
      <fieldset className="checkbox-set">
        <legend>{t("billing.tierGroup")}</legend>
        {paidPlanTiers.map((option) => (
          <label key={option} className="radio-row">
            <input
              type="radio"
              name="billing-tier"
              value={option}
              checked={tier === option}
              onChange={() => setTier(option)}
            />{" "}
            <span>
              <b>{t(`billing.tier.${option}`)}</b> · {t("billing.price.month", { price: formatEuroMinor(monthlyPriceMinor[option], locale) })}
              <br />
              <span className="muted">
                {t(`billing.allowance.${option}`, {
                  extra: formatEuroMinor(addOnMonthlyPriceMinor.studio.specialist, locale),
                })}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="checkbox-set">
        <legend>{t("billing.periodGroup")}</legend>
        {billingPeriods.map((option) => (
          <label key={option} className="radio-row">
            <input
              type="radio"
              name="billing-period"
              value={option}
              checked={period === option}
              onChange={() => setPeriod(option)}
            />{" "}
            {t(`billing.period.${option}`, { saving: periodSavingPercent(option) })}
          </label>
        ))}
      </fieldset>
      {discountCode ? (
        <p className="muted">
          {t("billing.founder", {
            seats: founderOffer.seats,
            percent: founderOffer.percentOff,
            code: discountCode,
          })}
        </p>
      ) : null}
      <div className="button-row">
        <PaddleCheckoutButton
          clientToken={clientToken}
          priceId={prices[tier][period]}
          environment={environment}
          organizationId={organizationId}
          discountCode={discountCode}
          label={checkoutLabel(tier, period, locale, register)}
        />
      </div>
    </div>
  );
}
