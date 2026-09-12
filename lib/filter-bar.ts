/**
 * The pieces the open filter bar is built from, shared by the four screens that
 * carry one: the calendar, the dashboard, the visit list and the monthly
 * report.
 *
 * Kept out of the components because every one of them is a rule rather than
 * markup — which months a locale names, which years a studio may reach for, and
 * what a filter's query string looks like when a field is left empty. Rules
 * deserve tests that do not need a renderer.
 */

/**
 * A path plus the filters that are actually set.
 *
 * Empty values are dropped rather than written as `?from=&to=`: the pages read
 * an absent parameter as "not filtered", and a query string full of empty
 * fields is the same state spelled in a way nobody can read in an address bar.
 */
export function queryFor(path: string, state: Readonly<Record<string, string | undefined>>) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(state)) if (value) params.set(name, value);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * «январь … декабрь», in the order a year runs them.
 *
 * The fifteenth at midday, not the first at midnight. `toLocaleDateString`
 * reads an instant in the browser's own zone, and a first-of-the-month instant
 * is within a few hours of the month before — far enough west and every name in
 * this list would be off by one.
 */
export function monthNames(localeTag: string, year: number): string[] {
  return Array.from({ length: 12 }, (_, index) =>
    new Date(Date.UTC(year, index, 15, 12)).toLocaleDateString(localeTag, { month: "long" }),
  );
}

/**
 * Two years back and one forward, which is where the work is: a studio reads
 * back over its own records and looks forward only as far as it takes bookings,
 * which `max_advance_days` caps in months rather than years.
 *
 * `anchor` joins the list wherever it falls, so a link somebody kept from
 * further back still shows the year it is actually on rather than silently
 * displaying a different one.
 *
 * `thisYear` is passed in rather than read from the clock: these render on the
 * server and hydrate in the browser, and `new Date()` on both sides of that is
 * two readings — on New Year's Eve, of two different years.
 */
export function yearOptions(thisYear: number, anchor: number): number[] {
  return [...new Set([anchor, thisYear - 2, thisYear - 1, thisYear, thisYear + 1])].sort(
    (left, right) => left - right,
  );
}

/**
 * The same date in another month or year, or the last day when there is no
 * same.
 *
 * «31 января» has no counterpart in February, and a calendar that normalizes it
 * lands in March — two months of movement from one change of one field. The end
 * of the month being entered is what a reader means by "this date, over there",
 * and it is what makes the step reversible: January's 31st becomes February's
 * 28th and comes back as January's 28th, which is a day, rather than a month
 * nobody asked for.
 */
export function dateIn(date: string, part: Readonly<{ year?: number; month?: number }>) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;

  const year = part.year ?? Number(match[1]);
  const month = part.month ?? Number(match[2]);
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Number(match[3]), lastDay);

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `YYYY-MM` as the two numbers its selects are set from. */
export function parseMonth(value: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;

  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year: Number(match[1]), month } : null;
}

/** And back, for the link a month select navigates to. */
export function formatMonth(year: number, month: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}
