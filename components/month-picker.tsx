"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { formatMonth, monthNames, parseMonth, queryFor, yearOptions } from "@/lib/filter-bar";

const PATH = "/app/reports/month";

/**
 * The month the profit-and-loss report is drawn for, as the calendar's bar.
 *
 * This is the one page whose period already was a month, so the two selects sit
 * on it exactly as they do on the calendar — where the calendar keeps a day in
 * the address and only looks at the month around it, this page has no day to
 * keep. It replaces «← Предыдущий месяц» / `input[type=month]` / «Показать»:
 * three controls and a press, for a choice a list of twelve makes in one.
 *
 * No specialist filter. The ledger this reads is the studio's — rent, wages,
 * subscriptions — and a month of it does not divide by master, so a control
 * offering to try would be a control that answers nothing.
 */
export function MonthPicker({
  locale,
  localeTag,
  month,
  thisMonth,
}: {
  locale: AppLocale;
  localeTag: string;
  /** `YYYY-MM`, the month on screen. */
  month: string;
  /** `YYYY-MM` where the studio is now, read on the server rather than the clock. */
  thisMonth: string;
}) {
  const t = getTranslator(locale);
  const router = useRouter();

  const anchor = parseMonth(month) ?? parseMonth(thisMonth)!;
  const names = monthNames(localeTag, anchor.year);
  const years = yearOptions(Number(thisMonth.slice(0, 4)), anchor.year);

  const go = (next: Readonly<{ year?: number; month?: number }>) =>
    router.push(
      queryFor(PATH, {
        month: formatMonth(next.year ?? anchor.year, next.month ?? anchor.month),
      }),
    );

  return (
    <nav className="calendar-where" aria-label={t("pl.month")}>
      <Link className="secondary-button" href={queryFor(PATH, { month: thisMonth })}>
        {t("pl.thisMonth")}
      </Link>

      <span className="calendar-period">
        <select
          aria-label={t("calendar.month")}
          value={anchor.month}
          onChange={(event) => go({ month: Number(event.target.value) })}
        >
          {names.map((name, index) => (
            <option key={name} value={index + 1}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label={t("calendar.year")}
          value={anchor.year}
          onChange={(event) => go({ year: Number(event.target.value) })}
        >
          {years.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>
      </span>
    </nav>
  );
}
