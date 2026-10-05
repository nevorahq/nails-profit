import Link from "next/link";

import type { ServiceRanking } from "@/domain/dashboard-metrics";
import { businessLabel, type BusinessType } from "@/i18n/business-labels";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";

/** As many services as a phone shows without the list becoming the page. */
const SHOWN = 5;

/**
 * The ranking as «Итог» shows it: four columns a phone can hold — the service,
 * how many visits, what was left, what was left per hour — and the rest one tap
 * away on the row itself. Every column, for every service, is «Услуги».
 *
 * A row opens with `<details>`: no script, and the browser's own keyboard and
 * screen-reader handling. A master's rows have nothing behind them — revenue,
 * the studio's share and the margin are not theirs to read — so theirs are
 * plain rows, and the third column is what the visit paid them.
 */
export function ServiceRankingCompact({
  ranking,
  locale,
  currency,
  businessType,
  isMaster,
  allHref,
}: {
  ranking: readonly ServiceRanking[];
  locale: AppLocale;
  currency: string;
  businessType: BusinessType;
  isMaster: boolean;
  /** «Услуги», on the same period. */
  allHref: string;
}) {
  const t = getTranslator(locale);
  const tag = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, tag);
  const thirdLabel = isMaster ? t("dashboard.commission") : t("dashboard.keeps");

  const cells = (entry: ServiceRanking) => {
    const third = isMaster ? entry.commissionMinor : entry.contributionMarginMinor;
    return (
      <>
        <span className="ranking-name">{entry.serviceName}</span>
        <span className="ranking-cell">
          <span className="sr-only">{t("dashboard.visitCount")}: </span>
          {entry.visits}
        </span>
        <span className={`ranking-cell${third < 0 ? " metric-negative" : ""}`}>
          <span className="sr-only">{thirdLabel}: </span>
          {money(third)}
        </span>
        <span className={`ranking-cell${(entry.profitPerHourMinor ?? 0) < 0 ? " metric-negative" : ""}`}>
          <span className="sr-only">{t("dashboard.hourly")}: </span>
          {entry.profitPerHourMinor === null ? "—" : money(entry.profitPerHourMinor)}
        </span>
      </>
    );
  };

  return (
    <section className="panel ranking-compact">
      <h2>{t("dashboard.rankingTitle")}</h2>
      <div className="ranking-row ranking-head" aria-hidden="true">
        <span className="ranking-name">{t("dashboard.service")}</span>
        <span className="ranking-cell">{t("dashboard.visitCount")}</span>
        <span className="ranking-cell">{thirdLabel}</span>
        <span className="ranking-cell">{t("dashboard.hourly")}</span>
      </div>
      <ul className="ranking-list">
        {ranking.slice(0, SHOWN).map((entry) => (
          <li key={entry.serviceId ?? entry.serviceName}>
            {isMaster ? (
              <div className="ranking-row">{cells(entry)}</div>
            ) : (
              <details className="ranking-details">
                <summary className="ranking-row">{cells(entry)}</summary>
                <dl className="ranking-more">
                  <div>
                    <dt>{t("dashboard.revenue")}</dt>
                    <dd>{money(entry.revenueMinor)}</dd>
                  </div>
                  <div>
                    <dt>{t(businessLabel.masterEarnings[businessType])}</dt>
                    <dd>{money(entry.commissionMinor)}</dd>
                  </div>
                  <div>
                    <dt>{t("dashboard.margin")}</dt>
                    <dd>{formatBasisPoints(entry.marginBasisPoints, tag)}</dd>
                  </div>
                </dl>
              </details>
            )}
          </li>
        ))}
      </ul>
      <Link className="text-link" href={allHref}>
        {t("dashboard.allServices")}
      </Link>
    </section>
  );
}
