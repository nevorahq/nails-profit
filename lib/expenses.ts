import { and, asc, count, eq, gte, isNull, lte, sum } from "drizzle-orm";

import { expenses } from "@/db/schema";
import { withTenant, type TenantTransaction } from "@/db/tenant";
import type { ExpenseCategory } from "@/domain/expense-categories";

/** One row of the ledger, as the page and its table read it. */
export type ExpenseRow = {
  id: string;
  name: string;
  category: ExpenseCategory;
  /** `YYYY-MM-DD`. The day the money was spent, not the day the row was written. */
  spent_on: string;
  amount_minor: number;
  currency: string;
  note: string | null;
  /** Rent and the like: one row with an interval, not twelve copies. */
  is_recurring: boolean;
  recurring_from: string | null;
  recurring_to: string | null;
};

export type ExpenseFilters = Readonly<{
  /** `YYYY-MM-DD`, as an `<input type="date">` submits it. */
  from?: string;
  to?: string;
  category?: ExpenseCategory;
}>;

/** `YYYY-MM-DD`, and a real day — `2026-02-31` and `вчера` are neither. */
export function isCalendarDay(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // Round-trip: Date rolls 2026-02-31 forward to March rather than refusing it.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/**
 * The ledger, oldest purchase first.
 *
 * Both the order and the period are the day the money was spent, never the day
 * the row was written: a receipt from last week entered today belongs in last
 * week's total. `created_at` breaks ties, so two purchases on one day keep the
 * order they were typed in.
 *
 * The comparison is `date` against `date`, so «с 1 по 3 августа» means those
 * three days whole — no timestamps, and no timezone to get wrong.
 */
function conditionsFor(filters: ExpenseFilters) {
  return [
    isNull(expenses.archivedAt),
    isCalendarDay(filters.from) ? gte(expenses.spentOn, filters.from) : undefined,
    isCalendarDay(filters.to) ? lte(expenses.spentOn, filters.to) : undefined,
    filters.category ? eq(expenses.category, filters.category) : undefined,
  ].filter((condition) => condition !== undefined);
}

export async function loadExpenses(
  organizationId: string,
  filters: ExpenseFilters = {},
): Promise<ExpenseRow[]> {
  const conditions = conditionsFor(filters);

  return withTenant(organizationId, (tx) =>
    tx
      .select({
        id: expenses.id,
        name: expenses.name,
        category: expenses.category,
        spent_on: expenses.spentOn,
        amount_minor: expenses.amountMinor,
        currency: expenses.currency,
        note: expenses.note,
        is_recurring: expenses.isRecurring,
        recurring_from: expenses.recurringFrom,
        recurring_to: expenses.recurringTo,
      })
      .from(expenses)
      .where(and(...conditions))
      .orderBy(asc(expenses.spentOn), asc(expenses.createdAt)),
  );
}

export type ExpenseTotal = Readonly<{
  /** The total, in the currency that was asked for. */
  minor: number;
  /**
   * Rows the total does not include because they are in another currency.
   * Zero in every ordinary ledger; above zero only where an organization
   * changed its currency and kept what it had recorded before.
   */
  excludedRows: number;
}>;

/**
 * What the ledger adds up to over the same filters — the figure the report's
 * «Затраты» card shows, and the one the table's own totals row shows.
 *
 * Grouped by currency rather than summed flat. `PATCH /organizations/settings`
 * lets an owner change the currency and deliberately converts nothing already
 * stored, so a ledger can hold both — and adding lei to euros produces a number
 * that is not money at all. Rows in another currency are counted out loud
 * instead: no conversion is invented, and nothing disappears quietly.
 *
 * Takes a transaction rather than an organization id because the report already
 * runs inside one: opening a second tenant transaction for a single SUM would
 * be a second connection for one number.
 *
 * `sum()` answers `null` on no rows and a string on the rest — a bigint column
 * can exceed what a JS number holds, which these amounts never do, so it is
 * parsed back to a number here.
 */
export async function sumExpensesMinor(
  tx: TenantTransaction,
  filters: ExpenseFilters,
  currency: string,
): Promise<ExpenseTotal> {
  const rows = await tx
    .select({ currency: expenses.currency, total: sum(expenses.amountMinor), rows: count() })
    .from(expenses)
    .where(and(...conditionsFor(filters)))
    .groupBy(expenses.currency);

  const wanted = rows.find((row) => row.currency === currency);
  const excludedRows = rows
    .filter((row) => row.currency !== currency)
    .reduce((total, row) => total + row.rows, 0);

  return { minor: wanted?.total ? Number(wanted.total) : 0, excludedRows };
}
