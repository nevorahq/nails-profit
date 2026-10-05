import { isMaterialCategory } from "@/domain/expense-classes";
import { expensesForMonth, type PeriodExpenseRow } from "@/domain/expense-periods";
import { roundRatio } from "@/domain/money";

/**
 * «По вашим закупкам ≈ X на визит»: a starting figure for the materials field,
 * worked out from what the studio already records instead of asked for.
 *
 * What was bought for materials and consumables over the last full months,
 * spread over the visits closed in them. It is an average across every service
 * — a pedicure and a quick polish change come out the same — so it is offered
 * as a suggestion to put in and adjust, never written by itself.
 *
 * Withheld rather than guessed when it would mislead: with too few visits one
 * crate of gel makes the average absurd, and with no purchases recorded there
 * is nothing to average. Rows in another currency are left out instead of
 * converted — the ledger keeps no rate to convert them by.
 */

/** Full months looked back over: one large order is smoothed, a change of supplier still shows. */
export const MATERIALS_HINT_MONTHS = 3;
/** Fewer closed visits than this, and the average says more about one purchase than about a visit. */
export const MATERIALS_HINT_MIN_VISITS = 20;

/** The `YYYY-MM` of the full months before `currentMonth`, oldest first. */
export function materialsHintMonths(currentMonth: string, count = MATERIALS_HINT_MONTHS): string[] {
  const [year, month] = currentMonth.split("-").map(Number);
  const months: string[] = [];
  for (let back = count; back >= 1; back -= 1) {
    const index = year * 12 + (month - 1) - back;
    months.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`);
  }
  return months;
}

export type MaterialsHintInput = Readonly<{
  /** The ledger, any currency; recurring rows are resolved per month here. */
  expenses: readonly (PeriodExpenseRow & Readonly<{ currency: string }>)[];
  /** Visits closed in `months`, in the organization's currency. */
  closedVisits: number;
  months: readonly string[];
  currency: string;
}>;

/** Minor units per visit, or null when there is not enough to say. */
export function materialsHint(input: MaterialsHintInput): number | null {
  if (input.closedVisits < MATERIALS_HINT_MIN_VISITS) return null;

  const ours = input.expenses.filter(
    (row) => row.currency === input.currency && isMaterialCategory(row.category),
  );
  const purchasedMinor = input.months.reduce(
    (total, month) =>
      total + expensesForMonth(ours, month).reduce((sum, row) => sum + row.amountMinor, 0),
    0,
  );
  if (purchasedMinor <= 0) return null;

  return roundRatio(purchasedMinor, input.closedVisits);
}
