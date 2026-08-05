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
