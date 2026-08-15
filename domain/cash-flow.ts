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
 * other way round. In the profit statement, materials count when a visit uses
 * them and the purchase is `cash_only`; here the purchase is the event and the
 * consumption is not a cash movement at all. Labour is the mirror image: the
 * ledger's `payroll` rows are left out, because the commission on each visit
 * and the monthly salaries are already the labour that leaves the account, and
 * counting both would pay the studio's masters twice on paper.
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
   * Operating profit for the same month, carried in so the statement can end
   * on the difference rather than leaving the reader to subtract two screens.
   */
  operatingProfitMinor: number;
}>;

export type CashFlow = Readonly<{
  month: string;

  revenueMinor: number;
  paymentCommissionMinor: number;
  /** What actually landed: takings less the acquirer's cut. */
  settledMinor: number;

  visitLabourMinor: number;
  salariedLabourMinor: number;
  /**
   * Every ledger row except `payroll`. Materials and consumables are in here at
   * their purchase price — this is the statement where buying a crate counts,
   * and using a bottle does not.
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
  const netCashMinor =
    settledMinor -
    input.visitLabourMinor -
    input.salariedLabourMinor -
    spentFromLedgerMinor -
    input.ownerDrawsMinor;

  return {
    month: input.month,

    revenueMinor: input.revenueMinor,
    paymentCommissionMinor: input.paymentCommissionMinor,
    settledMinor,

    visitLabourMinor: input.visitLabourMinor,
    salariedLabourMinor: input.salariedLabourMinor,
    spentFromLedgerMinor,
    spentByCategory,
    ledgerPayrollMinor,

    ownerDrawsMinor: input.ownerDrawsMinor,

    netCashMinor,

    operatingProfitMinor: input.operatingProfitMinor,
    profitToCashGapMinor: input.operatingProfitMinor - netCashMinor,
  };
}
