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

/**
 * Splits `amountMinor` into parts proportional to `weights`, summing exactly to
 * the amount.
 *
 * Largest remainder: every part is floored and the leftover minor units go one
 * each to the largest fractional parts, ties to the larger weight and then to
 * the earlier index, so the answer depends on nothing but the inputs. Rounding
 * each part on its own would let the parts drift a unit away from the whole,
 * and a report whose rows do not add up to its total is a report nobody trusts.
 *
 * All-zero weights split evenly: there is no proportion to follow, and dropping
 * the money would be worse than an arbitrary but stable split.
 *
 * BigInt inside, because an amount times a weight can pass 2^53 long before
 * either does.
 */
export function allocateProportionally(amountMinor: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError("The amount to allocate must be a non-negative safe integer");
  }
  if (weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)) {
    throw new RangeError("Weights must be non-negative safe integers");
  }
  if (weights.length === 0) {
    if (amountMinor === 0) return [];
    throw new RangeError("Cannot allocate an amount over no parts");
  }

  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const effective = total === 0 ? weights.map(() => 1) : weights;
  const denominator = BigInt(total === 0 ? weights.length : total);
  const amount = BigInt(amountMinor);

  const shares = effective.map((weight, index) => {
    const exact = amount * BigInt(weight);
    return { index, weight, floored: exact / denominator, remainder: exact % denominator };
  });

  let left = amount - shares.reduce((sum, share) => sum + share.floored, BigInt(0));
  const order = [...shares].sort((a, b) =>
    a.remainder === b.remainder
      ? b.weight - a.weight || a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  const parts = shares.map((share) => share.floored);
  for (const share of order) {
    if (left === BigInt(0)) break;
    parts[share.index] += BigInt(1);
    left -= BigInt(1);
  }

  return parts.map(Number);
}
