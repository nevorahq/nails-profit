/**
 * What the studio owes each master, and what it has handed over.
 *
 * «Начислено» is the work the month already counted as a cost: the commission
 * on the master's visits and their salary, without the employer's
 * contributions — those go to the state, not to the master. Tips are not in
 * it: they are handed on the day they are left, as the cash flow has always
 * assumed, and a cash tip never passed through the studio at all.
 *
 * The balance runs on from month to month, so a payout on the 5th of November
 * settles October. It starts the month before the studio's first payout: a
 * first payout almost always pays for the month just ended, and starting with
 * the month it was made in would read it as an overpayment — and would take
 * that month's wages out of the cash flow twice, once as owed the month before
 * and once as paid. Everything earlier is taken as settled, which is what the
 * cash flow has been saying about it all along.
 *
 * Pure: no database, no locale.
 */

export type MasterAccrual = Readonly<{
  specialistId: string;
  /** Commission on the month's visits. */
  commissionMinor: number;
  /** The month's salary, contributions excluded. */
  wageMinor: number;
}>;

export type PayoutRecord = Readonly<{
  specialistId: string;
  amountMinor: number;
  /** `YYYY-MM-DD`. */
  paidOn: string;
}>;

export type PayoutBalance = Readonly<{
  specialistId: string;
  /** What was still owed when the month opened. */
  openingMinor: number;
  commissionMinor: number;
  wageMinor: number;
  accruedMinor: number;
  paidMinor: number;
  /** Owed when the month closed; negative when more was paid than earned. */
  closingMinor: number;
}>;

export type PayoutLedger = Readonly<{
  month: string;
  /** The month the running balance starts in; null until the first payout. */
  startMonth: string | null;
  /** Whether this month is inside the tracked span, where the balance means something. */
  tracking: boolean;
  rows: readonly PayoutBalance[];
  totals: Readonly<{ openingMinor: number; accruedMinor: number; paidMinor: number; closingMinor: number }>;
}>;

/** `YYYY-MM` shifted by whole months. */
export function shiftMonth(month: string, by: number): string {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + by);
  return date.toISOString().slice(0, 7);
}

/** The month the running balance starts in: the one before the first payout's. */
export function payoutStartMonth(payouts: readonly PayoutRecord[]): string | null {
  if (payouts.length === 0) return null;
  const first = payouts.reduce((earliest, payout) => (payout.paidOn < earliest ? payout.paidOn : earliest), payouts[0].paidOn);
  return shiftMonth(first.slice(0, 7), -1);
}

/** Every month from `from` to `to`, both included. */
export function monthsBetween(from: string, to: string): readonly string[] {
  const months: string[] = [];
  for (let month = from; month <= to; month = shiftMonth(month, 1)) months.push(month);
  return months;
}

/**
 * The balance of every master in `month`.
 *
 * `accruals` must cover every month from the start month to `month` — the
 * balance is carried through each of them. A master appears when they earned
 * or were paid anything in the span, or are still owed something from it.
 */
export function buildPayoutLedger(input: {
  month: string;
  accruals: Readonly<Record<string, readonly MasterAccrual[]>>;
  payouts: readonly PayoutRecord[];
}): PayoutLedger {
  const startMonth = payoutStartMonth(input.payouts);
  const tracking = startMonth !== null && input.month >= startMonth;

  const paidIn = (month: string, specialistId: string) =>
    input.payouts
      .filter((payout) => payout.specialistId === specialistId && payout.paidOn.slice(0, 7) === month)
      .reduce((total, payout) => total + payout.amountMinor, 0);

  const months = tracking ? monthsBetween(startMonth, input.month) : [input.month];
  const people = new Set<string>();
  for (const month of months) {
    for (const accrual of input.accruals[month] ?? []) people.add(accrual.specialistId);
  }
  if (tracking) {
    for (const payout of input.payouts) {
      if (payout.paidOn.slice(0, 7) <= input.month) people.add(payout.specialistId);
    }
  }

  const rows: PayoutBalance[] = [];
  for (const specialistId of people) {
    let opening = 0;
    let row: PayoutBalance | null = null;
    for (const month of months) {
      const accrual = (input.accruals[month] ?? []).find((item) => item.specialistId === specialistId);
      const commissionMinor = accrual?.commissionMinor ?? 0;
      const wageMinor = accrual?.wageMinor ?? 0;
      const paidMinor = tracking ? paidIn(month, specialistId) : 0;
      const closing = opening + commissionMinor + wageMinor - paidMinor;
      row = {
        specialistId,
        openingMinor: opening,
        commissionMinor,
        wageMinor,
        accruedMinor: commissionMinor + wageMinor,
        paidMinor,
        closingMinor: closing,
      };
      opening = closing;
    }
    // Somebody whose span is settled and who did nothing this month is history.
    if (row && (row.openingMinor !== 0 || row.accruedMinor !== 0 || row.paidMinor !== 0 || row.closingMinor !== 0)) {
      rows.push(row);
    }
  }

  const sum = (pick: (row: PayoutBalance) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    month: input.month,
    startMonth,
    tracking,
    rows: rows.sort((left, right) => right.closingMinor - left.closingMinor),
    totals: {
      openingMinor: sum((row) => row.openingMinor),
      accruedMinor: sum((row) => row.accruedMinor),
      paidMinor: sum((row) => row.paidMinor),
      closingMinor: sum((row) => row.closingMinor),
    },
  };
}
