import Link from "next/link";

import { lowestTierFor, type PaidPlanTier, type PlanFeature } from "@/domain/plans";
import type { AppLocale } from "@/i18n/messages";
import { writtenRegister, type Register } from "@/i18n/lexicon";
import { getTranslator } from "@/i18n/t";

/** What a screen can be short of: a feature, or room for one more master or address. */
export type PlanLimit = Exclude<PlanFeature, "sms"> | "specialists" | "locations";

function tierFor(limit: PlanLimit): PaidPlanTier {
  if (limit === "specialists") return "studio";
  if (limit === "locations") return "business";
  return lowestTierFor(limit);
}

/**
 * Said where a tariff limit changes what the screen shows, in place of the
 * control it took away: what the current tier gives here, which tier opens
 * the rest, and the way to the subscription block in settings. Plain markup
 * with no state, so server pages and client components both draw it.
 */
export function PlanNotice({
  limit,
  locale,
  register = writtenRegister,
}: {
  limit: PlanLimit;
  locale: AppLocale;
  register?: Register;
}) {
  const t = getTranslator(locale, register);
  return (
    <p className="muted plan-notice">
      {t(`plan.limited.${limit}`, { tier: t(`billing.tier.${tierFor(limit)}`) })}{" "}
      <Link href="/app/settings#subscription">{t("plan.choose")}</Link>
    </p>
  );
}
