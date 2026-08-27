/**
 * The currencies a studio can keep its books in, in the order the pickers offer
 * them, and the one place the list is written.
 *
 * Everything that has to agree with it derives from it: the `currency` enum in
 * `db/schema.ts`, the `z.enum` of every endpoint that accepts one, and both
 * screens that let an owner choose. They used to repeat the pair by hand in a
 * dozen files, which is how a third one gets accepted by an endpoint and
 * refused by the column behind it.
 *
 * `RUB`, not `RUR`: the code ISO withdrew in 1998 still formats — as «р.» —
 * and would quietly mean the pre-denomination rouble, a thousand of which is
 * one of these. A `pgEnum` value cannot be dropped without rebuilding the type
 * under seven columns, so this is the kind of thing to get right once.
 */
export const currencies = ["MDL", "EUR", "RUB"] as const;

export type Currency = (typeof currencies)[number];

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
