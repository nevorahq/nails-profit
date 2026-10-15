import { PlanCheckout } from "@/components/plan-checkout";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { writtenRegister, type Register } from "@/i18n/lexicon";
import { localeTag } from "@/i18n/translate";
import { paddlePlanPrices } from "@/lib/paddle-catalog";

export type SubscriptionStatusRow = {
  provider: "paddle" | "lemon_squeezy";
  status: "trialing" | "active" | "past_due" | "paused" | "canceled";
  current_period_end: Date | null;
  manage_url: string | null;
};

export type CheckoutConfig = {
  paddle: { clientToken: string; environment: "sandbox" | "live"; discountCode: string | null } | null;
  lemonSqueezyUrl: string | null;
};

function lemonSqueezyCheckoutHref(baseUrl: string, organizationId: string) {
  const url = new URL(baseUrl);
  url.searchParams.set("checkout[custom][organization_id]", organizationId);
  return url.toString();
}

/**
 * Starting a subscription is one checkout, whichever provider answers behind
 * it. Paddle and Lemon Squeezy are both wired (see the payments research
 * artifact), but a studio has no use for two ways to do one thing: Paddle is
 * the main one, with a choice of tier and period over its catalog, and Lemon
 * Squeezy's link is only drawn when Paddle is not set up. An environment with
 * no catalog in `lib/paddle-catalog.ts` draws neither, so no button opens a
 * checkout for a price that does not exist.
 */
export function BillingSettings({
  subscription,
  checkout,
  organizationId,
  locale,
  register = writtenRegister,
}: {
  subscription: SubscriptionStatusRow | null;
  checkout: CheckoutConfig;
  organizationId: string;
  locale: AppLocale;
  /** Who is reading — see `i18n/lexicon.ts`. The dictionary as written when absent. */
  register?: Register;
}) {
  const t = getTranslator(locale, register);
  const paddlePrices = checkout.paddle ? paddlePlanPrices(checkout.paddle.environment) : null;

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
          {checkout.paddle && paddlePrices ? (
            <PlanCheckout
              clientToken={checkout.paddle.clientToken}
              environment={checkout.paddle.environment}
              prices={paddlePrices}
              organizationId={organizationId}
              discountCode={checkout.paddle.discountCode}
              locale={locale}
              register={register}
            />
          ) : !checkout.paddle && checkout.lemonSqueezyUrl ? (
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
