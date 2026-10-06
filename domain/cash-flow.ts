import type { ExpenseCategory } from "@/domain/expense-categories";
import type { ResolvedExpense } from "@/domain/expense-periods";

/**
 * Where the money went, as opposed to where the profit went.
 *
 * A separate statement, never folded into the P&L, because the two answer
 * different questions and disagreeing is the normal case: a studio can have a
 * profitable month and an empty account because it bought a quarter of gel, and
 * a terrible month with money in hand because the rent has not gone out yet.
 * Showing one number for both is how an owner ends up unable to explain either.
 *
 * The rule that keeps this honest is the same one the P&L follows, applied the
 * other way round. A purchase is an event here whatever it was for, so the
 * ledger comes in whole — with one exclusion, and it is the mirror of the P&L's
 * own: the ledger's `payroll` rows are left out, because the commission on each
 * visit and the monthly salaries are already the labour that leaves the
 * account, and counting both would pay the studio's masters twice on paper.
 *
 * Once the studio records what it hands its masters (`master_payout`), the
 * hired masters' pay stops being assumed and is read from those payouts
 * instead — see `masterPayouts` below. The payroll rows stay out either way:
 * a payout is the payment, so a «Зарплата» row beside it would be a second.
 *
 * That exclusion is exactly why `owner_draw` exists as its own table. Before
 * it, an owner taking money out filed it under `payroll` — where the profit
 * statement ignores it as already-counted labour, and where this statement
 * would now ignore it too. It would have vanished from both.
 *
 * Pure: no database, no locale, no formatting.
 */

export type CashFlowInput = Readonly<{
  /** `YYYY-MM`. */
  month: string;
  /** What clients paid, net of refunds — the visits' own revenue. */
  revenueMinor: number;
  /**
   * Rent owed by masters renting a chair, counted as received in the month it
   * is owed — the same assumption the visits' revenue makes. Absent means none.
   */
  chairRentMinor?: number;
  /** Withheld by the acquirer before the money ever reaches the account. */
  paymentCommissionMinor: number;
  /** Commission booked on this month's visits, including a principal's own. */
  visitLabourMinor: number;
  /** Monthly wages owed to hired people, employer's contributions included. */
  salariedLabourMinor: number;
  /** Ledger rows already resolved to this month and narrowed to one currency. */
  expenses: readonly ResolvedExpense[];
  /** Money the owner took for themselves this month. */
  ownerDrawsMinor: number;
  /**
   * What clients left on top this month. Absent means none.
   *
   * Never revenue, so the profit never sees it — which is exactly why it has
   * to be here: it is money that came into the account, and most of it went
   * straight back out to the master it was left for.
   */
  tipsMinor?: number;
  /**
   * The part of `tipsMinor` handed on to hired masters. A principal's tips stay
   * on the account: the money was theirs already, and taking it out is an
   * owner's draw like any other.
   */
  tipsPaidOutMinor?: number;
  /**
   * Operating profit for the same month, carried in so the statement can end
   * on the difference rather than leaving the reader to subtract two screens.
   */
  operatingProfitMinor: number;
  /**
   * What hired masters were actually handed this month, once the studio keeps
   * track of it (`domain/payouts.ts`). Absent means it does not, and their pay
   * is read as leaving the account the month it was earned, as it always was.
   *
   * Present, the statement switches to what happened: the hired masters'
   * commission and wages come out, the payouts go in, and what is still owed
   * is shown and not subtracted — it has not left. A principal's commission
   * and the employer's contributions stay as they were; neither is a payout.
   */
  masterPayouts?: Readonly<{
    paidMinor: number;
    /** Owed to hired masters when the month closed. */
    owedMinor: number;
    /** The hired masters' part of `visitLabourMinor`. */
    commissionMinor: number;
    /** The wages inside `salariedLabourMinor`, contributions excluded. */
    wageMinor: number;
  }>;
}>;

export type CashFlow = Readonly<{
  month: string;

  revenueMinor: number;
  paymentCommissionMinor: number;
  /** What actually landed: takings less the acquirer's cut. */
  settledMinor: number;
  chairRentMinor: number;
  /** Left on top by clients; the acquirer's cut on it is already above. */
  tipsMinor: number;
  /** Handed on to hired masters. */
  tipsPaidOutMinor: number;

  /** Per-visit labour leaving the account: all of it, or a principal's alone once payouts are tracked. */
  visitLabourMinor: number;
  /** Salaries leaving the account: whole, or only the contributions once payouts are tracked. */
  salariedLabourMinor: number;
  /** Handed to hired masters this month; null while payouts are not tracked. */
  masterPayoutsMinor: number | null;
  /** Still owed to hired masters at the month's end; shown, never subtracted. */
  owedToMastersMinor: number | null;
  /**
   * Every ledger row except `payroll`, at what was actually paid.
   */
  spentFromLedgerMinor: number;
  spentByCategory: Readonly<Record<string, number>>;
  /** Payroll rows, counted nowhere above and shown so the sum is explicable. */
  ledgerPayrollMinor: number;

  ownerDrawsMinor: number;

  netCashMinor: number;

  /**
   * Operating profit less net cash: why the two differ this month.
   *
   * Positive means the month earned more than it banked — stock bought ahead,
   * or an owner's draw. Negative means the account grew faster than the
   * business earned, which is usually a cost that has not gone out yet.
   */
  operatingProfitMinor: number;
  profitToCashGapMinor: number;
}>;

/** The one category this statement leaves out, and the reason it does. */
const COUNTED_AS_LABOUR: ExpenseCategory = "payroll";

export function buildCashFlow(input: CashFlowInput): CashFlow {
  const spent = input.expenses.filter((row) => row.category !== COUNTED_AS_LABOUR);
  const spentFromLedgerMinor = spent.reduce((total, row) => total + row.amountMinor, 0);

  const spentByCategory: Record<string, number> = {};
  for (const row of spent) {
    spentByCategory[row.category] = (spentByCategory[row.category] ?? 0) + row.amountMinor;
  }

  const ledgerPayrollMinor = input.expenses
    .filter((row) => row.category === COUNTED_AS_LABOUR)
    .reduce((total, row) => total + row.amountMinor, 0);

  const settledMinor = input.revenueMinor - input.paymentCommissionMinor;
  const tipsMinor = input.tipsMinor ?? 0;
  const tipsPaidOutMinor = input.tipsPaidOutMinor ?? 0;
  const chairRentMinor = input.chairRentMinor ?? 0;
  const payouts = input.masterPayouts;
  const visitLabourMinor = input.visitLabourMinor - (payouts?.commissionMinor ?? 0);
  const salariedLabourMinor = input.salariedLabourMinor - (payouts?.wageMinor ?? 0);
  const netCashMinor =
    settledMinor +
    chairRentMinor +
    tipsMinor -
    tipsPaidOutMinor -
    visitLabourMinor -
    salariedLabourMinor -
    (payouts?.paidMinor ?? 0) -
    spentFromLedgerMinor -
    input.ownerDrawsMinor;

  return {
    month: input.month,

    revenueMinor: input.revenueMinor,
    paymentCommissionMinor: input.paymentCommissionMinor,
    settledMinor,
    chairRentMinor,
    tipsMinor,
    tipsPaidOutMinor,

    visitLabourMinor,
    salariedLabourMinor,
    masterPayoutsMinor: payouts?.paidMinor ?? null,
    owedToMastersMinor: payouts?.owedMinor ?? null,
    spentFromLedgerMinor,
    spentByCategory,
    ledgerPayrollMinor,

    ownerDrawsMinor: input.ownerDrawsMinor,

    netCashMinor,

    operatingProfitMinor: input.operatingProfitMinor,
    profitToCashGapMinor: input.operatingProfitMinor - netCashMinor,
  };
}
