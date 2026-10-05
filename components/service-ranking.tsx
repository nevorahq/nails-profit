import type { DashboardMetrics } from "@/domain/dashboard-metrics";
import { businessLabel, type BusinessType } from "@/i18n/business-labels";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { writtenRegister, type Register } from "@/i18n/lexicon";
import { localeTag } from "@/i18n/translate";
import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";

/**
 * «Услуги по прибыли», every column — the table «Услуги» exists for.
 *
 * A master reads their own visits and what those paid them, and nothing about
 * what the studio charged or kept: the revenue, the studio's share and the
 * margin are not theirs, so those columns are not drawn rather than drawn blank.
 */
export function ServiceRankingTable({
  metrics,
  locale,
  register = writtenRegister,
  currency,
  businessType,
  isMaster,
}: {
  metrics: DashboardMetrics;
  locale: AppLocale;
  /** Who is reading — see `i18n/lexicon.ts`. The dictionary as written when absent. */
  register?: Register;
  currency: string;
  businessType: BusinessType;
  isMaster: boolean;
}) {
  const t = getTranslator(locale, register);
  const tag = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, tag);

  const totals = {
    // The visits the ranking was built from, once each: a visit of a manicure
    // and a pedicure is a row in both, and summing the rows would count it twice.
    visits: metrics.costedVisits,
    revenueMinor: metrics.ranking.reduce((s, e) => s + e.revenueMinor, 0),
    contributionMarginMinor: metrics.ranking.reduce((s, e) => s + e.contributionMarginMinor, 0),
    commissionMinor: metrics.ranking.reduce((s, e) => s + e.commissionMinor, 0),
  };

  // A column of zeros under «Оплата вашего труда» for somebody working alone
  // at a rate of nothing — the same column `FirstNumbers` leaves out.
  const earnings = !isMaster && !(businessType === "solo" && totals.commissionMinor === 0);

  return (
    <section className="panel">
      <h2>{t("dashboard.rankingTitle")}</h2>
      <p className="muted">{t("dashboard.rankingHint")}</p>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t("dashboard.service")}</th>
            <th>{t("dashboard.visitCount")}</th>
            {!isMaster && <th>{t("dashboard.revenue")}</th>}
            {earnings && <th>{t(businessLabel.masterEarnings[businessType])}</th>}
            <th>{isMaster ? t("dashboard.commission") : t("dashboard.keeps")}</th>
            {!isMaster && <th>{t("dashboard.margin")}</th>}
            <th>{t("dashboard.hourly")}</th>
          </tr>
        </thead>
        <tbody>
          {metrics.ranking.map((entry) => (
            <tr key={entry.serviceId ?? entry.serviceName}>
              <td>{entry.serviceName}</td>
              <td>{entry.visits}</td>
              {!isMaster && <td>{money(entry.revenueMinor)}</td>}
              {earnings && <td>{money(entry.commissionMinor)}</td>}
              {isMaster ? (
                <td>{money(entry.commissionMinor)}</td>
              ) : (
                <td className={entry.contributionMarginMinor < 0 ? "metric-negative" : ""}>
                  {money(entry.contributionMarginMinor)}
                </td>
              )}
              {!isMaster && <td>{formatBasisPoints(entry.marginBasisPoints, tag)}</td>}
              <td className={(entry.profitPerHourMinor ?? 0) < 0 ? "metric-negative" : ""}>
                {entry.profitPerHourMinor === null ? "—" : money(entry.profitPerHourMinor)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>{t("visits.total")}</th>
            <td>{totals.visits}</td>
            {!isMaster && <td>{money(totals.revenueMinor)}</td>}
            {earnings && <td>{money(totals.commissionMinor)}</td>}
            {isMaster ? (
              <td>{money(totals.commissionMinor)}</td>
            ) : (
              <td className={totals.contributionMarginMinor < 0 ? "metric-negative" : ""}>
                {money(totals.contributionMarginMinor)}
              </td>
            )}
            {!isMaster && <td />}
            <td />
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
