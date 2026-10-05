import { compareLocalDates, localToUtc, parseLocalDate } from "@/domain/timezone";
import { todayIn } from "@/domain/report-period";

/**
 * «Изменить с даты»: when a new version of a rule takes over from the one in
 * force.
 *
 * Commission, labour and tax rules are versioned rather than edited, and the
 * screens used to say so by offering «Завершить» and then a form for a new
 * rule — two acts, with a gap between them in which nothing applied. There is
 * one act now: a new value and the day it starts. The endpoint closes the
 * current rule at that instant and opens the new one at the same instant, in
 * one transaction; `active_from` is inclusive and `active_to` exclusive, so the
 * two meet without a gap and without an overlap.
 *
 * The day is the studio's own, and today or later. Today starts *now* rather
 * than at midnight: a visit closed this morning was costed by the old rule,
 * and the screen promises «прошлые визиты не изменятся». A later day starts at
 * that day's local midnight. An earlier one is refused — a labour rule is read
 * per month, so backdating it would rewrite a month already reported, and the
 * whole point of versioning is that history does not move.
 *
 * And it has to start after every rule it replaces. Closing a rule at or
 * before its own start would leave it an empty or inverted interval — which
 * `tax_rule_active_range` refuses outright, and which the other two tables
 * would keep as a rule that never applied while history says it did. That is
 * the case of a change already scheduled for next week and a second one typed
 * for tomorrow: the second is refused rather than slipped under the first.
 */
export type RuleChangeRefusal = "invalid_date" | "in_the_past" | "not_after_current";

export type RuleChangePlan =
  | Readonly<{
      ok: true;
      /** The rules in force, by id, and the instant they end. */
      close: Readonly<{ ids: readonly string[]; activeTo: Date }>;
      /** The instant the new rule starts — the same one. */
      open: Readonly<{ activeFrom: Date }>;
    }>
  | Readonly<{ ok: false; reason: RuleChangeRefusal }>;

export function planRuleChange(input: {
  /** The open rules of the scope being changed: `active_to` is null. */
  current: readonly Readonly<{ id: string; activeFrom: Date }>[];
  /** `YYYY-MM-DD` in the studio's zone; absent means now. */
  effectiveDate?: string | null;
  now: Date;
  timezone: string;
}): RuleChangePlan {
  let activeFrom = input.now;

  if (input.effectiveDate) {
    const date = parseLocalDate(input.effectiveDate);
    if (!date) return { ok: false, reason: "invalid_date" };

    const order = compareLocalDates(date, todayIn(input.now, input.timezone));
    if (order < 0) return { ok: false, reason: "in_the_past" };
    if (order > 0) activeFrom = localToUtc(date, 0, input.timezone);
  }

  if (input.current.some((rule) => rule.activeFrom.getTime() >= activeFrom.getTime())) {
    return { ok: false, reason: "not_after_current" };
  }

  return {
    ok: true,
    close: { ids: input.current.map((rule) => rule.id), activeTo: activeFrom },
    open: { activeFrom },
  };
}

/** The refusal as the API reports it, so all three endpoints say it alike. */
export const RULE_CHANGE_REFUSALS: Readonly<Record<RuleChangeRefusal, Readonly<{ code: string; message: string }>>> = {
  invalid_date: { code: "VALIDATION_ERROR", message: "effective_date is not a calendar date" },
  in_the_past: { code: "RULE_DATE_IN_PAST", message: "A rule can change from today or a later day" },
  not_after_current: {
    code: "RULE_DATE_BEFORE_CURRENT",
    message: "The rule in force starts on or after this date; choose a later one",
  },
};
