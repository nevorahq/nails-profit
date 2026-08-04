export type Currency = "MDL" | "EUR";

export type Money = Readonly<{
  amountMinor: number;
  currency: Currency;
}>;

export function money(amountMinor: number, currency: Currency): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError("Money must be a safe integer in minor units");
  }
  return { amountMinor, currency };
}

/**
 * Wire format from spec section 12.1: `{ "amount": 12550, "currency": "MDL" }`.
 * `amount` stays in minor units — the client divides for display, so no float
 * ever crosses the boundary.
 */
export type MoneyJson = {
  amount: number;
  currency: Currency;
};

export function toMoneyJson(amountMinor: number, currency: Currency): MoneyJson {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError("Money must be a safe integer in minor units");
  }
  return { amount: amountMinor, currency };
}

export function formatMoney(value: Money, locale = "ru-MD") {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: 2,
  }).format(value.amountMinor / 100);
}

/**
 * Half-away-from-zero rounding. A loss must round to the same magnitude as the
 * equivalent profit, otherwise negative margins drift toward zero.
 */
export function roundRatio(numerator: number, denominator: number) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError("Ratio operands must be safe integers and denominator must be positive");
  }
  const magnitude = Math.floor((Math.abs(numerator) + Math.floor(denominator / 2)) / denominator);
  // Guard against -0, which Intl renders as "-0,00 MDL".
  return numerator < 0 && magnitude !== 0 ? -magnitude : magnitude;
}
