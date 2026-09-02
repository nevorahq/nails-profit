import { PaddleCheckoutButton } from "@/components/paddle-checkout-button";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";

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
 * The checkout that starts a subscription is still a draft: Paddle and Lemon
 * Squeezy are both candidates (see the payments research artifact), so
 * `checkout` carries placeholders for both and each button only appears once
 * its own env vars are set — no button opens a checkout for a product that
 * does not exist yet. Once a real account is chosen, the other provider's
 * env vars simply stay unset and its button never renders.
 */
export function BillingSettings({
  subscription,
  checkout,
  organizationId,
  locale,
}: {
  subscription: SubscriptionStatusRow | null;
  checkout: CheckoutConfig;
  organizationId: string;
  locale: AppLocale;
}) {
  const t = getTranslator(locale);

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
          {(checkout.paddle || checkout.lemonSqueezyUrl) && (
            <div className="button-row">
              {checkout.paddle && (
                <PaddleCheckoutButton
                  clientToken={checkout.paddle.clientToken}
                  priceId={checkout.paddle.priceId}
                  environment={checkout.paddle.environment}
                  organizationId={organizationId}
                  label={t("billing.startPaddle")}
                />
              )}
              {checkout.lemonSqueezyUrl && (
                <a
                  className="secondary-button"
                  href={lemonSqueezyCheckoutHref(checkout.lemonSqueezyUrl, organizationId)}
                >
                  {t("billing.startLemonSqueezy")}
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
