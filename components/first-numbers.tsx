import type { ReactNode } from "react";

import Link from "next/link";

import { BookingLink } from "@/components/booking-link";

import type { Currency } from "@/domain/money";
import { businessLabel, type BusinessType } from "@/i18n/business-labels";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { writtenRegister, type Register } from "@/i18n/lexicon";
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
  register = writtenRegister,
  businessType,
  currency,
  bookingSlug,
  bookingClosed = false,
  closeDay,
}: {
  rows: readonly FirstNumberRow[];
  locale: AppLocale;
  /** Who is reading — see `i18n/lexicon.ts`. The dictionary as written when absent. */
  register?: Register;
  /** «Комиссия мастера» is a stranger's wage to a woman reading about her own. */
  businessType: BusinessType;
  currency: Currency;
  /** The studio's public address, when its page is actually live. */
  bookingSlug: string | null;
  /**
   * Whether the page could be opened but is not: the deployment offers public
   * booking and the studio has not opened it. Then the screen offers the way
   * there instead of the link — a link to a 404 is worse than none.
   */
  bookingClosed?: boolean;
  /**
   * Appointments that happened and were never closed. Shown first: a studio
   * still on this screen has no visit yet, and these are the first ones.
   */
  closeDay?: ReactNode;
}) {
  const t = getTranslator(locale, register);
  const localeCode = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeCode);
  /*
   * A column of zeros is a question nobody asked. Somebody working alone is
   * registered at a rate of nothing (`defaultCommissionBasisPointsFor`), and
   * her first screen would otherwise open on a column saying her work costs 0.
   */
  const paysForWork = rows.some((row) => row.commissionMinor !== 0);

  return (
    <main className="app-shell">
      {closeDay}
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
                {paysForWork && <th>{t(businessLabel.serviceCommission[businessType])}</th>}
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
                  {paysForWork && <td>{money(row.commissionMinor)}</td>}
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

        {!bookingSlug && bookingClosed && (
          <>
            <h3>{t("firstNumbers.closedTitle")}</h3>
            <p className="muted">{t("firstNumbers.closedBody")}</p>
            <div className="button-row">
              <Link className="primary-button" href="/app/setup">
                {t("firstNumbers.openBooking")}
              </Link>
            </div>
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
