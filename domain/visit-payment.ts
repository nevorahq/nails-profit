/**
 * What the client actually paid, turned into the lines a visit is costed from.
 *
 * A visit used to cost exactly its price list: whatever the catalogue said the
 * service and its add-ons were worth was the revenue, and there was no way to
 * say that this client paid 450 for a 500 manicure, or 650 because the design
 * went beyond what the add-on covers. The month then reported money nobody
 * received and missed money somebody did.
 *
 * The answer stays in the lines rather than in one adjusted total, because the
 * lines are what the rest of the costing already reads: a discount is what
 * `after_discount` commission is taken from and what `full_price` commission
 * ignores, and a refund later is checked against what the line charged.
 */

export type PricedLine = Readonly<{ priceMinor: number; discountMinor: number }>;

/** What a line still charges: its price less what was already taken off it. */
function chargeOf(line: PricedLine): number {
  return line.priceMinor - line.discountMinor;
}

/**
 * Spreads `amountMinor` of discount over the lines in proportion to what each
 * still charges.
 *
 * Proportional rather than «all of it off the service», so that a commission
 * rule covering only some services loses exactly its share of the discount and
 * no more. The shares are floored and the leftover minor units go one each to
 * the lines with the largest fractional part — the largest-remainder method —
 * so the lines always add up to the amount asked for, and no line is ever
 * discounted past its own price: a floored share plus one unit cannot exceed a
 * line's charge while the amount is below the total.
 *
 * An amount above what the lines charge is capped at it. A visit cannot be
 * cheaper than free, and the database refuses a discount larger than a price.
 */
export function spreadDiscount<Line extends PricedLine>(
  lines: readonly Line[],
  amountMinor: number,
): Line[] {
  const charges = lines.map(chargeOf);
  const total = charges.reduce((sum, charge) => sum + charge, 0);
  const amount = Math.min(Math.max(0, amountMinor), total);
  if (amount === 0) return [...lines];

  const shares = charges.map((charge, index) => {
    const exact = (amount * charge) / total;
    const floored = Math.floor(exact);
    return { index, floored, remainder: exact - floored, charge };
  });

  let left = amount - shares.reduce((sum, share) => sum + share.floored, 0);
  const extra = new Array<number>(lines.length).fill(0);
  // Ties go to the dearer line, then to the earlier one, so the result does
  // not depend on anything but the lines themselves.
  const order = [...shares].sort(
    (a, b) => b.remainder - a.remainder || b.charge - a.charge || a.index - b.index,
  );
  for (const share of order) {
    if (left === 0) break;
    if (share.floored + extra[share.index] < share.charge) {
      extra[share.index] += 1;
      left -= 1;
    }
  }

  return lines.map((line, index) => ({
    ...line,
    discountMinor: line.discountMinor + shares[index].floored + extra[index],
  }));
}

export type PaidAdjustment<Line extends PricedLine> = Readonly<{
  lines: Line[];
  /**
   * Paid above what the lines charge. The caller turns it into a line of its
   * own, because only the caller knows what a line needs beyond its price — a
   * name in three languages, which service it rides on.
   */
  surchargeMinor: number;
}>;

/**
 * Reconciles the lines with what the client paid.
 *
 * Equal changes nothing, which is every visit closed without the field. Less
 * becomes discount, spread as above. More becomes a surcharge the caller adds
 * as a line: the price list is left as it was, so the report can still tell
 * the sticker price from what the work actually fetched.
 */
export function applyPaidAmount<Line extends PricedLine>(
  lines: readonly Line[],
  paidMinor: number,
): PaidAdjustment<Line> {
  if (!Number.isSafeInteger(paidMinor) || paidMinor < 0) {
    throw new RangeError("The amount paid must be a non-negative integer in minor units");
  }

  const charged = lines.reduce((sum, line) => sum + chargeOf(line), 0);
  if (paidMinor < charged) {
    return { lines: spreadDiscount(lines, charged - paidMinor), surchargeMinor: 0 };
  }
  return { lines: [...lines], surchargeMinor: paidMinor - charged };
}
