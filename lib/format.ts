import type { Currency } from "@/domain/money";
import { fromMilliUnits } from "@/domain/units";

/** LOC-004: money, quantities and percentages go through locale-aware formatters. */
export function formatMoneyMinor(amountMinor: number, currency: Currency | string, locale = "ru-MD") {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency || "MDL",
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
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

export function formatQuantity(milliUnits: number, unit: string, locale = "ru-MD") {
  const value = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
    fromMilliUnits(milliUnits),
  );
  return `${value} ${unit}`;
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
  missing_recipe: "рецептура не задана",
  missing_material_cost: "у материала нет закупочной цены",
};
