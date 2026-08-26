import type { Currency } from "@/domain/money";

/** LOC-004: money, quantities and percentages go through locale-aware formatters. */
export function formatMoneyMinor(amountMinor: number, currency: Currency | string, locale = "ru-MD") {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency || "MDL",
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

/**
 * A `YYYY-MM-DD` day, written the way the locale writes days.
 *
 * Formatted in UTC on purpose: the value is a calendar day with no time in it,
 * and rendering it in the reader's zone would show the 2nd to anyone west of
 * Greenwich.
 */
export function formatDay(day: string, locale = "ru-MD") {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

export function formatBasisPoints(basisPoints: number | null, locale = "ru-MD") {
  if (basisPoints === null) return "—";
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(basisPoints / 10_000);
}

/**
 * Change against a same-length prior period, for the dashboard's period cards.
 * `roundRatio` in `domain/money.ts` rejects a zero or negative denominator, but
 * a prior period's profit can be either — a loss last week is exactly the case
 * this exists to show — so the sign is carried separately from a magnitude
 * denominator instead.
 */
export function formatPercentDelta(
  current: number,
  previous: number,
  locale = "ru-MD",
): { text: string; direction: "up" | "down" } | null {
  if (previous === 0) return null;
  const ratio = (current - previous) / Math.abs(previous);
  const text = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(ratio);
  // The formatted string's own minus sign is locale-drawn (U+2212 in several
  // locales, not ASCII "-"), so direction is read off the number instead of
  // parsed back out of the text made from it.
  return { text, direction: ratio < 0 ? "down" : "up" };
}

/**
 * Minutes as hours, for figures that are counted in shifts rather than in
 * appointments. One decimal: a month of capacity is a number in the hundreds,
 * and the minutes of it are noise no one acts on.
 *
 * The unit is not appended here. `formatDuration` below writes «мин» and «ч» in
 * Russian whatever the interface language is — a debt worth naming rather than
 * copying — so the caller adds a translated unit instead.
 */
export function formatHours(minutes: number, locale = "ru-MD") {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(minutes / 60);
}

export function formatDuration(minutes: number | null) {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** Why a costing could not be produced, in words a salon owner can act on. */
export const costingReasonLabels: Record<string, string> = {
  missing_price: "не указана цена услуги",
  missing_duration: "не указана длительность",
  missing_commission_rule: "нет правила комиссии мастера",
  no_revenue: "визит не принёс выручки",
};
