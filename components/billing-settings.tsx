import { PlanCheckout } from "@/components/plan-checkout";
import type { ResolvedPlan } from "@/domain/plans";
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

/** «Сейчас: пробный период «Студия» до 29 октября» — which tier, and why. */
export function currentPlanLabel(plan: ResolvedPlan, locale: AppLocale, register: Register = writtenRegister) {
  const t = getTranslator(locale, register);
  if (plan.tier === "start") return t("billing.current.free");
  const tier = t(`billing.tier.${plan.tier}`);
  if (plan.source === "trial" && plan.trialEndsAt) {
    return t("billing.current.trial", {
      tier,
      date: plan.trialEndsAt.toLocaleDateString(localeTag(locale), { day: "numeric", month: "long" }),
    });
  }
  if (plan.source === "pilot" && plan.trialEndsAt) {
    // The end is the first instant that is no longer free; the reader is told
    // the last day that still is.
    return t("billing.current.pilotUntil", {
      tier,
      date: new Date(plan.trialEndsAt.getTime() - 1).toLocaleDateString(localeTag(locale), {
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      }),
    });
  }
  if (plan.source === "pilot") return t("billing.current.pilot", { tier });
  return t("billing.current.paid", { tier });
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
  plan = null,
  organizationId,
  locale,
  register = writtenRegister,
}: {
  subscription: SubscriptionStatusRow | null;
  checkout: CheckoutConfig;
  /** The tier the studio is on now; the line is left out when absent. */
  plan?: ResolvedPlan | null;
  organizationId: string;
  locale: AppLocale;
  /** Who is reading — see `i18n/lexicon.ts`. The dictionary as written when absent. */
  register?: Register;
}) {
  const t = getTranslator(locale, register);
  const paddlePrices = checkout.paddle ? paddlePlanPrices(checkout.paddle.environment) : null;

  return (
    <section className="panel" id="subscription">
      <h2>{t("billing.title")}</h2>
      {plan ? <p>{t("billing.current", { plan: currentPlanLabel(plan, locale, register) })}</p> : null}
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
