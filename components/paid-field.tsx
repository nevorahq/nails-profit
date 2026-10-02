"use client";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatMoneyMinor } from "@/lib/format";

/**
 * «Клиент заплатил» — the one field both closing screens share.
 *
 * The visit form and the calendar card ask the same question about the same
 * money, and a second copy is how one of them starts accepting «450,50» while
 * the other refuses it. The line under the field says what the difference will
 * be recorded as, because «discount» and «surcharge» are the two ways the
 * report will read it and the person typing should not have to guess which.
 */

/** «450», «450.5» or «450,50» to minor units; null for anything else. */
export function toMinorUnits(input: string): number | null {
  const normalized = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const minor = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function toMajorUnits(minor: number): string {
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
}

export function PaidField({
  id,
  value,
  priceMinor,
  paidMinor,
  currency,
  locale,
  onChange,
}: {
  id: string;
  value: string;
  /** What the price list (or the booking's quote) says the visit costs. */
  priceMinor: number;
  /** The typed amount in minor units; null while untouched or unreadable. */
  paidMinor: number | null;
  currency: string;
  locale: AppLocale;
  onChange: (value: string) => void;
}) {
  const t = getTranslator(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeTag(locale));
  const hintId = `${id}-hint`;
  const unreadable = value.trim() !== "" && toMinorUnits(value) === null;

  let hint: string | null = null;
  if (unreadable) hint = t("closeVisit.paidInvalid");
  else if (paidMinor !== null && paidMinor < priceMinor) {
    hint = t("closeVisit.paidDiscount", { amount: money(priceMinor - paidMinor) });
  } else if (paidMinor !== null && paidMinor > priceMinor) {
    hint = t("closeVisit.paidSurcharge", { amount: money(paidMinor - priceMinor) });
  }

  return (
    <label htmlFor={id}>
      {t("closeVisit.paid", { currency })}
      <input
        id={id}
        name="paid"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        aria-invalid={unreadable}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && (
        <span id={hintId} className={unreadable ? "form-error" : "field-hint"}>
          {hint}
        </span>
      )}
    </label>
  );
}
