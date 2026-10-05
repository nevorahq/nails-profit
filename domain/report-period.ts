import { addLocalDays, formatLocalDate, parseLocalDate, toZonedParts, type LocalDate } from "@/domain/timezone";

/**
 * Which days the report answers for, when nobody has said.
 *
 * The report opens on the month the studio is in, by the studio's own clock: on
 * the evening of the 31st in Chișinău it is still that month, whatever UTC has
 * moved on to. Only *which* month is local. Its bounds stay the UTC instants
 * `lib/period.ts` cuts every month at, because the card on the report and the
 * monthly P&L must answer for exactly the same visits — and the P&L is cut in
 * UTC. Moving both to local midnight is a change to every past month's figures,
 * and is not this file's to make.
 *
 * Pure: the clock and the timezone are arguments, so the boundary cases are
 * tests rather than a wait for the first of the month.
 */

export type PeriodPreset = "this_month" | "last_month" | "year";

export type DayRange = Readonly<{ from: string; to: string }>;

export type ReportPeriod = Readonly<{
  /** Inclusive local days, `YYYY-MM-DD`; absent for an open end. */
  from?: string;
  to?: string;
  /** Which quick button this period is, or `custom` for any other. */
  preset: PeriodPreset | "custom";
  /** `YYYY-MM` when the period is exactly one calendar month, else null. */
  month: string | null;
}>;

/** The studio's calendar date at this instant. */
export function todayIn(now: Date, timezone: string): LocalDate {
  const parts = toZonedParts(now, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** `YYYY-MM` of the month the studio is in at this instant. */
export function currentMonthIn(now: Date, timezone: string): string {
  return formatLocalDate(todayIn(now, timezone)).slice(0, 7);
}

/** `YYYY-MM` → its first and last day. */
export function monthRange(month: string): DayRange {
  const [year, monthNumber] = month.split("-").map(Number);
  const first: LocalDate = { year, month: monthNumber, day: 1 };
  const nextFirst: LocalDate =
    monthNumber === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: monthNumber + 1, day: 1 };
  return { from: formatLocalDate(first), to: formatLocalDate(addLocalDays(nextFirst, -1)) };
}

/** The month before `YYYY-MM`. */
export function previousMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return monthNumber === 1
    ? `${year - 1}-12`
    : `${year}-${String(monthNumber - 1).padStart(2, "0")}`;
}

/** The days each quick button stands for, on a given local day. */
export function presetRanges(today: LocalDate): Readonly<Record<PeriodPreset, DayRange>> {
  const thisMonth = formatLocalDate(today).slice(0, 7);
  return {
    this_month: monthRange(thisMonth),
    last_month: monthRange(previousMonth(thisMonth)),
    year: { from: `${today.year}-01-01`, to: `${today.year}-12-31` },
  };
}

/** `YYYY-MM` when `from`–`to` is one whole calendar month, else null. */
export function wholeMonthOf(from: string | undefined, to: string | undefined): string | null {
  if (!from || !to || !parseLocalDate(from) || !parseLocalDate(to)) return null;
  const month = from.slice(0, 7);
  const range = monthRange(month);
  return range.from === from && range.to === to ? month : null;
}

/**
 * The period the report shows for this query string.
 *
 * Nothing set means the month the studio is in. Anything set is honoured as it
 * was before there was a default — an address bookmarked with `from` and `to`
 * still opens on those days, and one with `from` alone still runs to today.
 * Callers validate the strings first; this decides only what they mean.
 */
export function resolveReportPeriod(
  query: Readonly<{ from?: string; to?: string }>,
  today: LocalDate,
): ReportPeriod {
  const presets = presetRanges(today);

  if (!query.from && !query.to) {
    return { ...presets.this_month, preset: "this_month", month: presets.this_month.from.slice(0, 7) };
  }

  const preset =
    (Object.keys(presets) as PeriodPreset[]).find(
      (key) => presets[key].from === query.from && presets[key].to === query.to,
    ) ?? "custom";

  return { from: query.from, to: query.to, preset, month: wholeMonthOf(query.from, query.to) };
}

/**
 * The days a period is compared against for «к прошлому периоду».
 *
 * A whole month is compared with the whole month before it — September with
 * August, not with the thirty days that happen to precede it, which would start
 * on the 1st or the 2nd depending on the month. Any other closed period is
 * compared with the window of the same length right before it. An open end has
 * no length, and so nothing to compare with.
 */
export function previousRangeOf(period: ReportPeriod): DayRange | null {
  if (period.month) return monthRange(previousMonth(period.month));
  if (!period.from || !period.to) return null;

  const from = parseLocalDate(period.from);
  const to = parseLocalDate(period.to);
  if (!from || !to) return null;

  const days =
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / 86_400_000 + 1;
  if (days < 1) return null;

  return {
    from: formatLocalDate(addLocalDays(from, -days)),
    to: formatLocalDate(addLocalDays(from, -1)),
  };
}
