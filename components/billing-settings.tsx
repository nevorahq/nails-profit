import { PaddleCheckoutButton } from "@/components/paddle-checkout-button";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { writtenRegister, type Register } from "@/i18n/lexicon";
import { localeTag } from "@/i18n/translate";
import type { PaddlePlan } from "@/lib/paddle-api";

export type SubscriptionStatusRow = {
  provider: "paddle" | "lemon_squeezy";
  status: "trialing" | "active" | "past_due" | "paused" | "canceled";
  current_period_end: Date | null;
  manage_url: string | null;
};

export type CheckoutConfig = {
  paddle: { clientToken: string; priceId: string; environment: "sandbox" | "live" } | null;
  lemonSqueezyUrl: string | null;
};

function lemonSqueezyCheckoutHref(baseUrl: string, organizationId: string) {
  const url = new URL(baseUrl);
  url.searchParams.set("checkout[custom][organization_id]", organizationId);
  return url.toString();
}

/**
 * The one button's text: «Оформить подписку», and the tariff with its price
 * when the provider told us one — «Оформить подписку · Студия, €29 в месяц».
 * Without a plan it is the bare action, never a price made up.
 */
export function startLabel(plan: PaddlePlan | null, locale: AppLocale, register: Register = writtenRegister) {
  const t = getTranslator(locale, register);
  if (!plan) return t("billing.start");

  const price = new Intl.NumberFormat(localeTag(locale), {
    style: "currency",
    currency: plan.currency,
    minimumFractionDigits: plan.amountMinor % 100 === 0 ? 0 : 2,
  }).format(plan.amountMinor / 100);
  const priced = plan.interval ? t(`billing.price.${plan.interval}`, { price }) : price;
  return t("billing.startPlan", { plan: plan.name ? `${plan.name}, ${priced}` : priced });
}

/**
 * Starting a subscription is one button, whichever provider answers behind it.
 * Paddle and Lemon Squeezy are both wired (see the payments research
 * artifact), but a studio has no use for two ways to do one thing: Paddle is
 * the main one, and Lemon Squeezy's link is only drawn when Paddle is not set
 * up, so no button opens a checkout for a product that does not exist yet.
 */
export function BillingSettings({
  subscription,
  checkout,
  plan = null,
  organizationId,
  locale,
  register = writtenRegister,
}: {
  subscription: SubscriptionStatusRow | null;
  checkout: CheckoutConfig;
  /** What Paddle says the checkout's price is, when it said. */
  plan?: PaddlePlan | null;
  organizationId: string;
  locale: AppLocale;
  /** Who is reading — see `i18n/lexicon.ts`. The dictionary as written when absent. */
  register?: Register;
}) {
  const t = getTranslator(locale, register);

  return (
    <section className="panel">
      <h2>{t("billing.title")}</h2>
      {subscription ? (
        <div>
          <p>
            {t("billing.status")}: {t(`billing.status.${subscription.status}`)}
          </p>
          {subscription.current_period_end ? (
            <p className="muted">
              {t("billing.periodEnd", {
                date: subscription.current_period_end.toLocaleDateString(localeTag(locale)),
              })}
            </p>
          ) : null}
          {subscription.manage_url ? (
            <a className="secondary-button" href={subscription.manage_url} target="_blank" rel="noopener noreferrer">
              {t("billing.manage")}
            </a>
          ) : null}
        </div>
      ) : (
        <div>
          <p className="muted">{t("billing.none")}</p>
          {checkout.paddle ? (
            <div className="button-row">
              <PaddleCheckoutButton
                clientToken={checkout.paddle.clientToken}
                priceId={checkout.paddle.priceId}
                environment={checkout.paddle.environment}
                organizationId={organizationId}
                label={startLabel(plan, locale, register)}
              />
            </div>
          ) : checkout.lemonSqueezyUrl ? (
            <div className="button-row">
              <a className="primary-button" href={lemonSqueezyCheckoutHref(checkout.lemonSqueezyUrl, organizationId)}>
                {t("billing.start")}
              </a>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
