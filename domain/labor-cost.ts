import { roundRatio } from "@/domain/money";

/**
 * Labour a month owes and no visit does.
 *
 * A master on a monthly salary and the owner's own imputed wage are the same
 * mechanism: an amount that belongs to the period rather than to any of the
 * visits inside it. A salary does not divide into whichever visits happened to
 * occur, and the owner is paid by what is left over.
 *
 * Where they part company is which side of the operating profit they fall on.
 * A salary is a cost of running the place and comes out above the line; the
 * owner's imputed wage comes out below it, and that subtraction is the whole
 * difference between «сколько осталось» and «заработал ли бизнес сверх моего
 * труда». `domain/period-pl.ts` keeps them apart.
 */

export type LaborCostRecipient = "owner" | "specialist";
export type LaborCostBasis = "fixed_monthly" | "percent_revenue";

export type LaborCostRuleRow = Readonly<{
  id: string;
  recipient: LaborCostRecipient;
  /** Set exactly when `recipient` is "specialist"; the database checks it. */
  specialistId: string | null;
  label: string | null;
  basis: LaborCostBasis;
  amountMinor: number | null;
  basisPoints: number | null;
  payrollTaxBasisPoints: number;
  activeFrom: Date;
  activeTo: Date | null;
}>;

/** `YYYY-MM` of a date, in UTC — the same key `expensesForMonth` compares on. */
function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/**
 * Whom a rule is for. The owner is the organization's own, so every owner rule
 * shares one key and only the newest of them applies; a specialist's rules are
 * keyed by the specialist.
 */
function recipientKey(rule: LaborCostRuleRow): string {
  return rule.recipient === "owner" ? "owner" : `specialist:${rule.specialistId}`;
}

/**
 * The rules in force in `month`, one per recipient.
 *
 * Rules are versioned rather than edited — raising a salary in June must leave
 * January reporting January's — so several rows can match one recipient. Taking
 * all of them would pay the same person twice, which is the quiet arithmetic
 * this function exists to prevent: the newest `activeFrom` wins, exactly as in
 * `selectCommissionRule`.
 *
 * The boundary is the month, not the day: a salary agreed on the 15th of March
 * is a March cost, and one ended on the 10th of August was paid for August.
 * Anything finer would need a proration nobody recorded.
 */
export function selectLaborRules(
  rules: readonly LaborCostRuleRow[],
  month: string,
): readonly LaborCostRuleRow[] {
  const active = rules.filter(
    (rule) =>
      monthOf(rule.activeFrom) <= month && (rule.activeTo === null || month <= monthOf(rule.activeTo)),
  );

  const newestPerRecipient = new Map<string, LaborCostRuleRow>();
  for (const rule of active) {
    const key = recipientKey(rule);
    const held = newestPerRecipient.get(key);
    if (!held || rule.activeFrom.getTime() >= held.activeFrom.getTime()) {
      newestPerRecipient.set(key, rule);
    }
  }

  return [...newestPerRecipient.values()];
}

/**
 * What the rule costs the month, employer's contributions included.
 *
 * The tax is charged on the wage, and both are rounded once — the wage from the
 * revenue, then the tax from the wage. Rounding the two together would leave a
 * total that does not equal the two lines the report prints beneath it.
 */
export function monthlyLaborCostMinor(
  rule: LaborCostRuleRow,
  context: Readonly<{ revenueMinor: number }>,
): number {
  const wage =
    rule.basis === "fixed_monthly"
      ? (rule.amountMinor ?? 0)
      : roundRatio(context.revenueMinor * (rule.basisPoints ?? 0), 10_000);

  return wage + roundRatio(wage * rule.payrollTaxBasisPoints, 10_000);
}

/** Everything owed to the salaried, and everything owed to the owner, apart. */
export function laborCostTotals(
  rules: readonly LaborCostRuleRow[],
  context: Readonly<{ revenueMinor: number }>,
): Readonly<{ salariedMinor: number; ownerMinor: number | null }> {
  let salariedMinor = 0;
  let ownerMinor: number | null = null;

  for (const rule of rules) {
    const cost = monthlyLaborCostMinor(rule, context);
    if (rule.recipient === "owner") {
      // Null until somebody says what their work is worth. Never zero: a wage
      // read as zero is the claim that the owner's time is free, and it would
      // turn straight into economic profit that does not exist.
      ownerMinor = (ownerMinor ?? 0) + cost;
      continue;
    }
    salariedMinor += cost;
  }

  return { salariedMinor, ownerMinor };
}
