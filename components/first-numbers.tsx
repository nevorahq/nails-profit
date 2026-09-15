import Link from "next/link";

import { BookingLink } from "@/components/booking-link";

import type { Currency } from "@/domain/money";
import { businessLabel, type BusinessType } from "@/i18n/business-labels";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";
import type { FirstNumberRow } from "@/lib/first-numbers";

/**
 * The first screen of a studio that is set up and has not sold anything yet.
 *
 * It answers the question the product exists for — «сколько мне приносит эта
 * работа» — out of the catalogue alone, because a price, a duration and a rate
 * are all the costing engine needs. Before this, the same studio met a
 * dashboard of zeroes and had to close a visit before the product said
 * anything at all.
 *
 * Deliberately not a copy of the dashboard with zeroes hidden. Every column
 * here is per service and none of them is a sum over time: nothing on this
 * screen claims to know what the studio earned, and the one line under the
 * table says plainly where that figure comes from and what it is waiting for.
 *
 * A server component: nothing here reacts to anything.
 */
export function FirstNumbers({
  rows,
  locale,
  businessType,
  currency,
  bookingSlug,
}: {
  rows: readonly FirstNumberRow[];
  locale: AppLocale;
  /** «Комиссия мастера» is a stranger's wage to a woman reading about her own. */
  businessType: BusinessType;
  currency: Currency;
  /** The studio's public address, when its page is actually live. */
  bookingSlug: string | null;
}) {
  const t = getTranslator(locale);
  const localeCode = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeCode);

  return (
    <main className="app-shell">
      <section className="panel">
        <h2>{t("firstNumbers.title")}</h2>
        <p className="muted">{t("firstNumbers.lead")}</p>

        {rows.length === 0 ? (
          <p className="muted">{t("firstNumbers.empty")}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("dashboard.service")}</th>
                <th>{t("services.priceIn", { currency })}</th>
                <th>{t(businessLabel.serviceCommission[businessType])}</th>
                <th>{t(businessLabel.serviceKept[businessType])}</th>
                <th>{t("dashboard.margin")}</th>
                <th>{t("dashboard.hourly")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{money(row.priceMinor)}</td>
                  <td>{money(row.commissionMinor)}</td>
                  <td className={row.contributionMarginMinor < 0 ? "metric-negative" : ""}>
                    {money(row.contributionMarginMinor)}
                  </td>
                  <td>{formatBasisPoints(row.marginBasisPoints, localeCode)}</td>
                  <td className={(row.profitPerHourMinor ?? 0) < 0 ? "metric-negative" : ""}>
                    {row.profitPerHourMinor === null ? "—" : money(row.profitPerHourMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {bookingSlug && (
          <>
            {/*
              And the prices above are the prices on it. Said here because the
              two are read in different places and changed in a third: an owner
              who does not know the page is live reads the table as a private
              calculation.
            */}
            <h3>{t("firstNumbers.bookingTitle")}</h3>
            <p className="muted">{t("firstNumbers.bookingBody")}</p>
            <BookingLink slug={bookingSlug} locale={locale} />
          </>
        )}

        {/*
          What this screen is not: a month. Said here rather than left for the
          owner to discover from an empty report — the figures above are what
          the work is worth, and what the studio actually earned starts being
          counted at the first closed visit.

          «Закрыть первый визит» used to be the button under this line, and it
          was the last piece of homework left on the screen: a studio that has
          not had a client yet can only answer it by inventing one. A visit is
          work; it gets closed from the calendar on the day it happens.
        */}
        <p className="muted">{t("firstNumbers.waiting")}</p>
        <div className="button-row">
          <Link className="primary-button" href="/app/services">
            {t("firstNumbers.editServices")}
          </Link>
        </div>
      </section>
    </main>
  );
}
