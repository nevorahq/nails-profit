import type { ExpenseCategory } from "@/domain/expense-categories";
import { expenseClassOf, type ExpenseClass } from "@/domain/expense-classes";

/**
 * Turning the ledger into "what this month cost".
 *
 * A one-off purchase belongs to the month it was spent in. A recurring one —
 * rent, a subscription — is stored as a single row with an interval rather than
 * materialised twelve times: raising the rent in March must not rewrite
 * January, and the way to guarantee that is for January never to have held a
 * row that March could edit. A change of amount closes the old row with
 * `recurringTo` and opens a new one with `recurringFrom`.
 *
 * Every function here is currency-blind and expects rows already narrowed to
 * one currency. Mixing is a question for the caller, which is the only layer
 * that knows which currency the report is being drawn in — see
 * `lib/period.ts`.
 */

export type PeriodExpenseRow = Readonly<{
  id: string;
  name: string;
  category: ExpenseCategory;
  amountMinor: number;
  /** `YYYY-MM-DD`. For a recurring row, the day of the month it is paid on. */
  spentOn: string;
  isRecurring: boolean;
  /** `YYYY-MM-DD`, required when `isRecurring`. */
  recurringFrom: string | null;
  /** `YYYY-MM-DD`, or null for "still running". */
  recurringTo: string | null;
}>;

export type ResolvedExpense = PeriodExpenseRow &
  Readonly<{
    /** `YYYY-MM` this row is being counted in. */
    month: string;
    class: ExpenseClass;
  }>;

/** `YYYY-MM` of a `YYYY-MM-DD`. String comparison is the whole trick. */
function monthOf(day: string): string {
  return day.slice(0, 7);
}

/**
 * The rows that count towards `month`, expressed as `YYYY-MM`.
 *
 * Boundary rule, stated once so it is not re-guessed at each call site: the
 * month containing `recurringFrom` counts, and so does the month containing
 * `recurringTo`. Rent that starts on the 15th of March is a March cost — the
 * business paid it that month — and rent cancelled on the 10th of August was
 * paid for August. Anything finer would need to know each contract's proration,
 * which the ledger does not record and the owner did not type.
 */
export function expensesForMonth(
  rows: readonly PeriodExpenseRow[],
  month: string,
): readonly ResolvedExpense[] {
  return rows
    .filter((row) => {
      if (!row.isRecurring) return monthOf(row.spentOn) === month;
      // A recurring row without a start is not a recurring row; the database
      // check refuses it, and reading it as "since forever" would silently
      // charge every month in history.
      if (!row.recurringFrom) return false;
      if (month < monthOf(row.recurringFrom)) return false;
      return row.recurringTo === null || month <= monthOf(row.recurringTo);
    })
    .map((row) => ({ ...row, month, class: expenseClassOf[row.category] }));
}

export function totalByClass(
  resolved: readonly ResolvedExpense[],
): Readonly<Record<ExpenseClass, number>> {
  return resolved.reduce(
    (totals, row) => ({ ...totals, [row.class]: totals[row.class] + row.amountMinor }),
    { overhead: 0, cash_only: 0 } as Record<ExpenseClass, number>,
  );
}

/**
 * Totals per category, listing only the categories that actually occurred: a
 * report full of zero rows hides the three lines that matter.
 */
export function byCategory(
  resolved: readonly ResolvedExpense[],
): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const row of resolved) {
    totals[row.category] = (totals[row.category] ?? 0) + row.amountMinor;
  }
  return totals;
}
