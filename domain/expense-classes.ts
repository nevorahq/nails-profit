import { expenseCategories, type ExpenseCategory } from "@/domain/expense-categories";

/**
 * Whether a recorded expense belongs in the month's profit, or only in its cash.
 *
 * The ledger holds two different kinds of thing under one word. Rent is a cost
 * of the month and nothing else knows about it. A crate of gel is money leaving
 * the account, but the *cost* of that gel already reaches the report through
 * the visits that used it — `consumption` priced at the visit's own snapshot.
 * Subtracting both would charge the business twice for one bottle, and the two
 * figures would not even be equal: one is what was bought, the other what was
 * used.
 *
 * So the ledger is split rather than summed. `overhead` is subtracted from the
 * contribution margin to give the operating profit; `cash_only` is shown, and
 * deliberately not subtracted, because the same money is counted elsewhere.
 *
 * What this costs, honestly: a consumable nobody put in a recipe — paper
 * towels, gloves — reaches no visit and so reaches no profit either. That gap
 * is the reason the monthly report carries the reconciliation line «закуплено
 * против списано» (`domain/period-pl.ts`): the difference is visible rather
 * than assumed away. See `docs/cost-engine-redesign-plan.md`, section 3.
 */
export type ExpenseClass = "overhead" | "cash_only";

export const expenseClassOf: Readonly<Record<ExpenseCategory, ExpenseClass>> = {
  rent: "overhead",
  // Wages reach the report through `financial_snapshot.commission_minor` for
  // per-visit work, and through `labor_cost_rule` for a salary. A payroll line
  // in the ledger is the payment, not a second cost.
  payroll: "cash_only",
  tools: "overhead",
  // Priced per unit and consumed by a recipe: the cost arrives with the visit.
  materials: "cash_only",
  consumables: "cash_only",
  taxes: "overhead",
  subscriptions: "overhead",
  marketing: "overhead",
  transport: "overhead",
  services: "overhead",
  other: "overhead",
};

/**
 * The categories whose purchases the materials reconciliation compares against
 * what the visits actually consumed.
 */
export const purchasedMaterialCategories: readonly ExpenseCategory[] = ["materials", "consumables"];

export function isOverhead(category: ExpenseCategory): boolean {
  return expenseClassOf[category] === "overhead";
}

/** Every category, in the order the interface offers them, grouped by class. */
export function categoriesOfClass(expenseClass: ExpenseClass): readonly ExpenseCategory[] {
  return expenseCategories.filter((category) => expenseClassOf[category] === expenseClass);
}
