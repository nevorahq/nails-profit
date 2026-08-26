import { expenseCategories, type ExpenseCategory } from "@/domain/expense-categories";

/**
 * Whether a recorded expense belongs in the month's profit, or only in its cash.
 *
 * The ledger holds two different kinds of thing under one word. Rent is a cost
 * of the month and nothing else knows about it. Wages are money leaving the
 * account too, but what the master's work cost already reaches the report
 * through the visit — `financial_snapshot.commission_minor` — and through
 * `labor_cost_rule` for a salary. Subtracting both would pay the studio's
 * masters twice on paper.
 *
 * So the ledger is split rather than summed. `overhead` is subtracted from the
 * contribution margin to give the operating profit; `cash_only` is shown, and
 * deliberately not subtracted, because the same money is counted elsewhere.
 *
 * Materials used to sit on the `cash_only` side, because their cost reached the
 * report a second time through the recipe of every visit that consumed them.
 * With the material engine gone that second path no longer exists, and a crate
 * of gel is now an ordinary cost of the month like any other purchase: what was
 * bought is what is subtracted. It is a coarser number than per-visit
 * consumption was — a crate bought in March is charged to March even if it is
 * poured out over the summer — and that is the price of the simpler product.
 */
export type ExpenseClass = "overhead" | "cash_only";

export const expenseClassOf: Readonly<Record<ExpenseCategory, ExpenseClass>> = {
  rent: "overhead",
  // Wages reach the report through `financial_snapshot.commission_minor` for
  // per-visit work, and through `labor_cost_rule` for a salary. A payroll line
  // in the ledger is the payment, not a second cost.
  payroll: "cash_only",
  tools: "overhead",
  materials: "overhead",
  consumables: "overhead",
  taxes: "overhead",
  subscriptions: "overhead",
  marketing: "overhead",
  transport: "overhead",
  services: "overhead",
  other: "overhead",
};

export function isOverhead(category: ExpenseCategory): boolean {
  return expenseClassOf[category] === "overhead";
}

/** Every category, in the order the interface offers them, grouped by class. */
export function categoriesOfClass(expenseClass: ExpenseClass): readonly ExpenseCategory[] {
  return expenseCategories.filter((category) => expenseClassOf[category] === expenseClass);
}
