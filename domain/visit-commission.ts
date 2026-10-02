import type { Commission, CommissionBase } from "@/domain/costing";
import { roundRatio } from "@/domain/money";

/**
 * The master's commission on a visit whose lines may fall under different
 * rules.
 *
 * A visit used to carry one rule, because it carried one service. With several
 * — a manicure at 40% and a pedicure the studio pays a flat 150 for — the rule
 * is chosen per service and copied onto the lines it covers, and this sums them.
 *
 * Lines that came from the same rule are one group, and the group pays its
 * fixed amount once: «150 за визит» stays a sum per visit however many of its
 * services the rule happens to cover, which is what the arrangement meant
 * before a visit could hold two. The percentage is taken on the group's base as
 * a whole, rounded once — so a visit whose lines share one rule costs exactly
 * what it did when the rule lived on the visit, unit for unit.
 */

export type CommissionTerms = Readonly<{
  /** The rule these terms were copied from. Lines that share it share its fixed amount. */
  ruleKey: string;
  commission: Commission;
  base: CommissionBase;
}>;

export type CommissionedLine = Readonly<{
  priceMinor: number;
  discountMinor: number;
  refundMinor?: number;
  /** Absent reads as true, as in `domain/visit-profit.ts`. */
  commissionable?: boolean;
  /**
   * The rule this line is paid under. Null on every line written before rules
   * moved onto lines, which then all fall under the visit's own rule — one
   * group, and the figure they were costed at.
   */
  terms?: CommissionTerms | null;
}>;

export type CommissionGroup = Readonly<{
  ruleKey: string;
  commissionMinor: number;
  /** Indexes into the lines passed in. */
  lineIndexes: readonly number[];
}>;

export type LineCommission = Readonly<{
  totalMinor: number;
  groups: readonly CommissionGroup[];
  /**
   * What each line contributes to its group's percentage base: zero for a line
   * the rule does not cover. Kept so a report splitting a visit by service can
   * attribute each group's commission to the lines that earned it.
   */
  lineBaseMinor: readonly number[];
}>;

function assertNonNegativeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
}

function fixedOf(commission: Commission): number {
  return commission.type === "percentage" ? 0 : commission.amountMinor;
}

function basisPointsOf(commission: Commission): number {
  return commission.type === "fixed" ? 0 : commission.basisPoints;
}

export function commissionOfLines(
  lines: readonly CommissionedLine[],
  fallback: CommissionTerms,
): LineCommission {
  const lineBaseMinor = lines.map((line) => {
    if (line.commissionable === false) return 0;
    const base = (line.terms ?? fallback).base;
    return base === "full_price"
      ? line.priceMinor
      : line.priceMinor - line.discountMinor - (line.refundMinor ?? 0);
  });

  const byRule = new Map<string, { terms: CommissionTerms; lineIndexes: number[] }>();
  lines.forEach((line, index) => {
    const terms = line.terms ?? fallback;
    const group = byRule.get(terms.ruleKey);
    if (group) group.lineIndexes.push(index);
    else byRule.set(terms.ruleKey, { terms, lineIndexes: [index] });
  });

  const groups = [...byRule.values()].map(({ terms, lineIndexes }) => {
    const fixedMinor = fixedOf(terms.commission);
    const basisPoints = basisPointsOf(terms.commission);
    assertNonNegativeInteger(fixedMinor, "commission.amountMinor");
    assertNonNegativeInteger(basisPoints, "commission.basisPoints");

    const baseMinor = lineIndexes.reduce((total, index) => total + lineBaseMinor[index], 0);
    assertNonNegativeInteger(baseMinor, "commissionBaseMinor");

    return {
      ruleKey: terms.ruleKey,
      commissionMinor: fixedMinor + (basisPoints > 0 ? roundRatio(baseMinor * basisPoints, 10_000) : 0),
      lineIndexes,
    };
  });

  return {
    totalMinor: groups.reduce((total, group) => total + group.commissionMinor, 0),
    groups,
    lineBaseMinor,
  };
}
