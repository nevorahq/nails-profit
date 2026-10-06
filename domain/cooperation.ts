/**
 * What the way a master works with the studio decides about their default rule.
 *
 * A master renting a chair keeps what their clients pay, and a master on a
 * salary is paid by the month (`labor_cost_rule`). Either way the visit owes
 * them nothing, and that has to be said by a rule of 0%: without any rule the
 * visit refuses to close (MISSING_COMMISSION_RULE), and with the 40% they were
 * hired on it would pay them a second time. The studio used to be told to write
 * the zero by hand, in a hint under the rate field; this is that step, taken in
 * the same transaction that changes the cooperation.
 *
 * Pure: the caller reads the rules and writes what this answers.
 */

export type Cooperation = "commission" | "rent" | "staff";

/** Whether this way of working is paid per visit at all. */
export function paidPerVisit(cooperation: Cooperation): boolean {
  return cooperation === "commission";
}

export type DefaultRuleRow = Readonly<{
  id: string;
  type: string;
  basisPoints: number | null;
  fixedAmountMinor: number | null;
  activeFrom: Date;
  activeTo: Date | null;
}>;

/** A rule that charges nothing whatever the visit costs. */
export function paysNothing(rule: Pick<DefaultRuleRow, "basisPoints" | "fixedAmountMinor">): boolean {
  return (rule.basisPoints ?? 0) === 0 && (rule.fixedAmountMinor ?? 0) === 0;
}

export type ZeroRulePlan = Readonly<{
  /** Rules to end, and the instant each ends at. */
  close: readonly Readonly<{ id: string; activeTo: Date }>[];
  /** Whether a 0% rule has to be written from `now`. */
  open: boolean;
}>;

/**
 * The default rules of one master that are still in force or still to come,
 * turned into a single 0% from now on.
 *
 * The rule in force ends now, and a rule scheduled for a later day is ended at
 * its own start — an interval of nothing, so it never applies but stays in the
 * history the owner wrote. Ended rather than deleted for that reason. A rule in
 * force that already pays nothing is kept, so pressing «аренда» twice does not
 * leave two identical rows.
 */
export function planZeroRule(rules: readonly DefaultRuleRow[], now: Date): ZeroRulePlan {
  const live = rules.filter((rule) => rule.activeTo === null || rule.activeTo.getTime() > now.getTime());
  const scheduled = live.filter((rule) => rule.activeFrom.getTime() > now.getTime());
  const inForce = live.filter((rule) => rule.activeFrom.getTime() <= now.getTime());
  const keep = inForce.length === 1 && paysNothing(inForce[0]);

  return {
    close: [
      ...(keep ? [] : inForce.map((rule) => ({ id: rule.id, activeTo: now }))),
      ...scheduled.map((rule) => ({ id: rule.id, activeTo: rule.activeFrom })),
    ],
    open: !keep,
  };
}
