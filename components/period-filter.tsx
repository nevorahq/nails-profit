"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import type { DayRange, PeriodPreset } from "@/domain/report-period";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { queryFor } from "@/lib/filter-bar";

/**
 * The period and specialist filter, shared by the report and the visit list.
 *
 * Open on the page, the way the calendar's bar is. It used to be three fields
 * and a «Показать» folded behind a «Фильтры» button — two taps before the
 * question could even be asked, and on a phone a panel that opened off the side
 * of the screen. Choosing is applying now: each control navigates on change,
 * through the same query string the pages already read.
 *
 * The specialist select is omitted rather than disabled when the caller's scope
 * is "own": section 6.1 limits a Master to their own rows, and a control that
 * cannot change anything only invites the question of why it is there.
 *
 * `usePathname` rather than a prop, because the two callers differ only in
 * where they live: the dashboard and the visit list read the same three
 * parameters and each wants to stay on its own page.
 */
export function PeriodFilter({
  locale,
  from,
  to,
  specialistId,
  people,
  showSpecialist,
  presets,
}: {
  locale: AppLocale;
  from?: string;
  to?: string;
  specialistId?: string;
  people: readonly { id: string; name: string }[];
  showSpecialist: boolean;
  /**
   * The report's quick buttons, and which of them the page is on. Given, they
   * replace «Всё время»: the report opens on this month, so the way back is
   * «Этот месяц», and the dates fold behind «Свой период». The visit list
   * passes none and keeps its open-ended default.
   */
  presets?: Readonly<{
    ranges: Readonly<Record<PeriodPreset, DayRange>>;
    active: PeriodPreset | "custom";
  }>;
}) {
  const t = getTranslator(locale);
  const router = useRouter();
  const path = usePathname();
  // Open on arrival when the period is already one of the user's own making —
  // the dates are then the only control that says what is on the screen.
  const [customOpen, setCustomOpen] = useState(presets?.active === "custom");
  const showDates = !presets || customOpen;

  const current = { from, to, specialist: specialistId };
  const go = (next: Readonly<Record<string, string>>) =>
    router.push(queryFor(path, { ...current, ...next }));

  const presetHref = (preset: PeriodPreset) =>
    // This month is the report's default, so it is addressed by saying nothing:
    // a bookmark of it stays «this month» next month too.
    preset === "this_month"
      ? queryFor(path, { specialist: specialistId })
      : queryFor(path, { ...presets!.ranges[preset], specialist: specialistId });

  const presetLabels: Readonly<Record<PeriodPreset, string>> = {
    this_month: t("filters.thisMonth"),
    last_month: t("filters.lastMonth"),
    year: t("filters.year"),
  };

  return (
    <>
      {presets && (
        <div className="period-presets" role="group" aria-label={t("filters.period")}>
          {(Object.keys(presetLabels) as PeriodPreset[]).map((preset) => (
            <Link
              key={preset}
              className="period-preset"
              href={presetHref(preset)}
              aria-current={presets.active === preset && !customOpen ? "true" : undefined}
              onClick={() => setCustomOpen(false)}
            >
              {presetLabels[preset]}
            </Link>
          ))}
          <button
            type="button"
            className="period-preset"
            aria-expanded={customOpen}
            aria-current={presets.active === "custom" || customOpen ? "true" : undefined}
            onClick={() => setCustomOpen((open) => !open)}
          >
            {t("filters.custom")}
          </button>
        </div>
      )}
      {(showSpecialist || showDates) && (
        <div className="calendar-where">
          {showSpecialist && (
            <select
              className="calendar-specialist"
              aria-label={t("filters.specialist")}
              value={specialistId ?? ""}
              onChange={(event) => go({ specialist: event.target.value })}
            >
              {/*
                The fuller wording, not «все». The label above this select is
                `sr-only` now, so the option has to carry the question as well as
                the answer — «все» on its own in a bar names nothing.
              */}
              <option value="">{t("calendar.allSpecialists")}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          )}

          {/*
            The way back, and the counterpart of «Сегодня» on the calendar: one
            press returns the page to the period it opens on. Clearing two date
            fields by hand is the alternative, and a native date input is not a
            thing anybody clears twice happily.

            The master is carried over rather than reset with the dates — the two
            questions are «за какой срок» and «чей», and answering the first should
            not silently widen the second.
          */}
          {!presets && (
            <Link className="secondary-button" href={queryFor(path, { specialist: specialistId })}>
              {t("filters.reset")}
            </Link>
          )}

          {/*
            Both dates in one wrapper, which is what puts the line break between the
            master and the period on a phone rather than wherever the widths happen
            to land. `.calendar-period` is the calendar's own group of two; the rule
            that places it is about the pair, not about what the pair contains.
          */}
          {showDates && (
            <span className="calendar-period">
              <label>
                <span className="sr-only">{t("filters.from")}</span>
                <input
                  type="date"
                  value={from ?? ""}
                  max={to || undefined}
                  onChange={(event) => go({ from: event.target.value })}
                />
              </label>
              <label>
                <span className="sr-only">{t("filters.to")}</span>
                <input
                  type="date"
                  value={to ?? ""}
                  min={from || undefined}
                  onChange={(event) => go({ to: event.target.value })}
                />
              </label>
            </span>
          )}
        </div>
      )}
    </>
  );
}
