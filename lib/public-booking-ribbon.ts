/**
 * The ribbon of coming days on the public booking page — the parts that are
 * arithmetic rather than layout, so they can be tested without a browser.
 */

/** How many days the ribbon shows; the API caps a request at the same number. */
export const RIBBON_DAYS = 14;

export type RibbonDay = Readonly<{ date: string; slots: readonly unknown[] }>;

/**
 * Today as the location's own calendar says it, `YYYY-MM-DD`. The client's
 * device clock and zone are the wrong ones to ask: a client in Bucharest
 * booking in Chișinău, or a laptop left on another zone, would be offered
 * yesterday or tomorrow as the first day.
 */
export function dateInZone(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** The first day that has a free time, or null when the whole ribbon is empty. */
export function firstDayWithTimes(days: readonly RibbonDay[]): string | null {
  return days.find((day) => day.slots.length > 0)?.date ?? null;
}
