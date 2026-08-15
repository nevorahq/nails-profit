import { NO_TAXES, type TaxRates } from "@/domain/costing";

/**
 * The tax rates in force at a moment in time.
 *
 * Versioned rather than edited, like `commission_rule`: a VAT rate that changes
 * in July must leave June's visits reporting June's, and the rule is resolved
 * for the instant the visit closed rather than for now.
 *
 * One rate per kind. Two overlapping VAT rules are a data error rather than a
 * sum, so the newer wins outright — adding them would produce a number no law
 * anywhere charges.
 */
export type TaxRuleRow = Readonly<{
  kind: "vat" | "turnover" | "payroll";
  basisPoints: number;
  remittable: boolean;
  activeFrom: Date;
  activeTo: Date | null;
}>;

export function selectTaxRates(rules: readonly TaxRuleRow[], at: Date): TaxRates {
  const newestByKind = new Map<TaxRuleRow["kind"], TaxRuleRow>();

  for (const rule of rules) {
    if (rule.activeFrom.getTime() > at.getTime()) continue;
    if (rule.activeTo !== null && rule.activeTo.getTime() <= at.getTime()) continue;

    const current = newestByKind.get(rule.kind);
    if (!current || rule.activeFrom.getTime() >= current.activeFrom.getTime()) {
      newestByKind.set(rule.kind, rule);
    }
  }

  const vat = newestByKind.get("vat");

  return {
    vatBasisPoints: vat?.basisPoints ?? 0,
    // Only VAT is ever handed on, so the flag is read from that rule alone. A
    // rule that exists but is not remitted keeps its rate visible in the
    // snapshot while taking nothing out of the margin.
    remittableVat: vat?.remittable ?? false,
    turnoverBasisPoints: newestByKind.get("turnover")?.basisPoints ?? 0,
    payrollBasisPoints: newestByKind.get("payroll")?.basisPoints ?? 0,
  };
}

/**
 * Whether a set of rates would change any figure.
 *
 * Used to decide whether a visit needs a tax snapshot at all: a studio that has
 * entered no taxes should store null rather than four zeros, so that «налогов
 * не было» and «никто не спрашивал» stay distinguishable in the row.
 */
export function hasAnyTax(rates: TaxRates): boolean {
  return (
    (rates.remittableVat && rates.vatBasisPoints > 0) ||
    rates.turnoverBasisPoints > 0 ||
    rates.payrollBasisPoints > 0
  );
}

export { NO_TAXES };
