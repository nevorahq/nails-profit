import Link from "next/link";

import type { Headline } from "@/domain/headline";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatMoneyMinor } from "@/lib/format";

/**
 * «Сколько я заработала в этом месяце», answered as the first thing on the
 * report and sized to be read at arm's length on a phone.
 *
 * Draws a `Headline` and computes nothing: what the figure is, and for whom, is
 * `domain/headline.ts`. The month is always printed, because the card follows
 * the filter only when the filter is a month — a year or a span of days has no
 * rent of its own to subtract, and the card then stays on the current month and
 * has to say so.
 */
export function HeadlineCard({
  headline,
  locale,
  currency,
  month,
  isCurrentMonth,
  detailsHref,
}: {
  headline: Headline;
  locale: AppLocale;
  currency: string;
  /** `YYYY-MM` the figure is for. */
  month: string;
  isCurrentMonth: boolean;
  /** The month's own statement, for a role that may open it. */
  detailsHref: string | null;
}) {
  const t = getTranslator(locale);
  const tag = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, tag);
  const monthName = new Intl.DateTimeFormat(tag, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00.000Z`),
  );

  const label = isCurrentMonth
    ? t(`headline.${headline.kind}.current`)
    : t(`headline.${headline.kind}.month`, { month: monthName });

  return (
    <section className="panel headline-card" aria-labelledby="headline-label">
      <span className="headline-month">{monthName}</span>
      <h2 className="headline-label" id="headline-label">
        {label}
      </h2>
      <p className="headline-figure">
        {/* A floor said in words, before the figure it qualifies — the same
            claim `pl.marginFloor` makes at length on the monthly report. */}
        {headline.floor && <span className="headline-at-least">{t("headline.atLeast")}</span>}
        <strong
          className={`headline-value${headline.amountMinor < 0 ? " metric-negative" : ""}`}
          data-testid="headline-value"
        >
          {money(headline.amountMinor)}
        </strong>
      </p>

      {headline.kind === "contribution" && <p className="headline-note">{t("headline.contributionHint")}</p>}

      {headline.kind === "operating" && (
        <p className="headline-note">
          {t("headline.split", { revenue: money(headline.revenueMinor), costs: money(headline.costsMinor) })}
        </p>
      )}

      {headline.kind === "operating" && headline.breakEven && (
        <div className="headline-break-even">
          <div
            className="headline-bar"
            role="progressbar"
            aria-label={t("headline.breakEvenBar")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(headline.breakEven.progressBasisPoints / 100)}
          >
            <span style={{ width: `${headline.breakEven.progressBasisPoints / 100}%` }} />
          </div>
          <p className="headline-note">
            {headline.breakEven.toGoMinor === 0
              ? t("headline.breakEvenReached", { target: money(headline.breakEven.targetMinor) })
              : t("headline.breakEvenToGo", {
                  target: money(headline.breakEven.targetMinor),
                  amount: money(headline.breakEven.toGoMinor),
                })}
          </p>
        </div>
      )}

      {headline.floor && (
        <p className="headline-note">
          {/* A master is told how many, not what they were sold for: their
              figure is a share of that revenue, and the full sum beside it
              reads as money they are owed. */}
          {headline.kind === "earnings"
            ? t("headline.floorVisits", { count: headline.floor.visits })
            : t("headline.floor", { count: headline.floor.visits, revenue: money(headline.floor.revenueMinor) })}
        </p>
      )}

      {detailsHref && (
        <Link className="text-link headline-details" href={detailsHref}>
          {t("headline.details")}
        </Link>
      )}
    </section>
  );
}
