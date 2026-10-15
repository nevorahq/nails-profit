import Link from "next/link";

import { lowestTierFor, type PlanFeature } from "@/domain/plans";
import type { AppLocale } from "@/i18n/messages";
import { writtenRegister, type Register } from "@/i18n/lexicon";
import { getTranslator } from "@/i18n/t";

/**
 * Said where a tariff limit changes what the screen shows, in place of the
 * control it took away: what «Старт» gives here, which tier opens the rest,
 * and the way to the subscription block in settings.
 */
export function PlanNotice({
  feature,
  locale,
  register = writtenRegister,
}: {
  feature: Extract<PlanFeature, "full_reports">;
  locale: AppLocale;
  register?: Register;
}) {
  const t = getTranslator(locale, register);
  return (
    <p className="muted plan-notice">
      {t(`plan.limited.${feature}`, { tier: t(`billing.tier.${lowestTierFor(feature)}`) })}{" "}
      <Link href="/app/settings#subscription">{t("plan.choose")}</Link>
    </p>
  );
}
