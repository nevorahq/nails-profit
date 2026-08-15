/**
 * Categories for a recorded expense.
 *
 * A closed list rather than free text: the point of recording an expense is to
 * add it up with the others later, and two spellings of "аренда" are two lines
 * in a report that should have been one. The database enum is generated from
 * this array (`db/schema.ts`), so the two can never drift.
 *
 * Adding a category means adding its `expenses.category.<name>` key to every
 * locale — `domain/expense-categories.test.ts` fails otherwise.
 */
export const expenseCategories = [
  "rent",
  "payroll",
  "tools",
  "materials",
  "taxes",
  "subscriptions",
  "marketing",
  "consumables",
  "transport",
  "services",
  "other",
] as const;

export type ExpenseCategory = (typeof expenseCategories)[number];

/**
 * What the add form starts on. "Прочие" rather than a substantive category: a
 * pre-selected "Материалы" that nobody looked at files the expense under a
 * claim the person never made.
 *
 * Not a server-side default — the API requires a category, because a select
 * always sends one and a request that omits it is a bug worth seeing.
 */
export const defaultExpenseCategory: ExpenseCategory = "other";

export function isExpenseCategory(value: string): value is ExpenseCategory {
  return (expenseCategories as readonly string[]).includes(value);
}
