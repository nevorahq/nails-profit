import type { Commission, CommissionType } from "@/domain/costing";

/**
 * Picks the commission rule in force for a service at a moment in time,
 * spec RES-005 and CST-009.
 *
 * Rules are versioned rather than edited, so several may match. Precedence:
 * a per-service exception beats the specialist's default, and among equals the
 * most recently effective rule wins. Nothing here mutates history — asking for
 * a past date returns the rule that applied then.
 */
export type CommissionRuleRow = Readonly<{
  id: string;
  serviceId: string | null;
  type: CommissionType;
  basisPoints: number | null;
  fixedAmountMinor: number | null;
  activeFrom: Date;
  activeTo: Date | null;
}>;

/*
 * Generic over the row so callers keep the columns they selected. The choice of
 * rule depends only on the fields declared above; everything else a caller
 * carries — the base, the covered services — has to survive the pick, and a
 * concrete return type would quietly drop it.
 */
export function selectCommissionRule<Row extends CommissionRuleRow>(
  rules: readonly Row[],
  serviceId: string,
  at: Date = new Date(),
): Row | null {
  const applicable = rules.filter(
    (rule) =>
      (rule.serviceId === null || rule.serviceId === serviceId) &&
      rule.activeFrom.getTime() <= at.getTime() &&
      (rule.activeTo === null || rule.activeTo.getTime() > at.getTime()),
  );

  if (applicable.length === 0) return null;

  return applicable.reduce((best, candidate) => {
    const bestIsException = best.serviceId !== null;
    const candidateIsException = candidate.serviceId !== null;
    if (candidateIsException !== bestIsException) return candidateIsException ? candidate : best;
    return candidate.activeFrom.getTime() >= best.activeFrom.getTime() ? candidate : best;
  });
}

/** Converts a stored rule into the shape the costing engine consumes. */
export function toCommission(rule: CommissionRuleRow): Commission {
  switch (rule.type) {
    case "fixed":
      if (rule.fixedAmountMinor === null) {
        throw new Error(`Commission rule ${rule.id} is fixed but has no amount`);
      }
      return { type: "fixed", amountMinor: rule.fixedAmountMinor };
    case "percentage":
    case "percentage_after_materials":
      if (rule.basisPoints === null) {
        throw new Error(`Commission rule ${rule.id} is ${rule.type} but has no rate`);
      }
      return { type: rule.type, basisPoints: rule.basisPoints };
    case "hybrid":
      // Both halves, or it is not a hybrid. The database says the same thing in
      // `commission_rule_shape`; this is what a row that slipped past it reads
      // as, and throwing beats costing the visit at half the agreement.
      if (rule.basisPoints === null || rule.fixedAmountMinor === null) {
        throw new Error(`Commission rule ${rule.id} is hybrid but is missing a rate or an amount`);
      }
      return { type: "hybrid", basisPoints: rule.basisPoints, amountMinor: rule.fixedAmountMinor };
  }
}
