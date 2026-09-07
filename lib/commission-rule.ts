import type { SpecialistRow } from "@/lib/specialist-cards";
import type { Translate } from "@/i18n/t";
import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";

/**
 * A commission rule in words, and a commission rule out of a form.
 *
 * Both screens that deal with a master need both: the list describes the rule
 * in a cell, the card describes each exception and writes new ones. They lived
 * inside the list component until the card existed, which would have meant two
 * copies of the empty-field rule below — the sort of duplicate that is only
 * noticed once the two have already disagreed.
 */
export function describeRule(
  rule: SpecialistRow["default_rule"],
  currency: string,
  t: Translate,
): string | null {
  if (!rule) return null;
  if (rule.type === "fixed") {
    return t("specialists.perService", {
      amount: formatMoneyMinor(rule.fixed_amount_minor ?? 0, currency),
    });
  }
  const rate = formatBasisPoints(rule.basis_points);
  if (rule.type === "hybrid") {
    return t("specialists.hybridRule", {
      amount: formatMoneyMinor(rule.fixed_amount_minor ?? 0, currency),
      rate,
    });
  }
  const described = t("specialists.ofRevenue", { rate });
  // Only worth saying when it is not the usual answer. Every rule written
  // before the base existed is `after_discount`, and labelling all of them
  // would be noise on every row.
  return rule.base === "full_price" ? `${described} · ${t("commissionBase.full_price")}` : described;
}

/**
 * The three shapes the API and the database both insist on: an amount, a rate,
 * or — for a hybrid — one of each. Null when the form does not describe one.
 */
export function ruleFromForm(data: FormData) {
  const type = String(data.get("rule_type"));
  /*
   * An empty field is not a zero.
   *
   * `Number("")` is 0 and passes `Number.isFinite`, so leaving the box blank
   * used to write a real 0% rule: the master appeared to work for nothing,
   * every margin on the dashboard read too high, and nothing on screen said
   * so — a rule was there, so no banner and no refusal. A blank field means
   * the question was not answered, and the form says so instead.
   */
  const typed = String(data.get("rule_value") ?? "").trim();
  const value = Number(typed);
  if (typed === "" || !Number.isFinite(value)) return null;

  const base = String(data.get("rule_base") ?? "after_discount");
  if (type === "fixed") return { type, fixed_amount_minor: Math.round(value * 100) };

  const typedGuarantee = String(data.get("rule_guaranteed") ?? "").trim();
  const guaranteed = Number(typedGuarantee);
  if (type === "hybrid") {
    if (typedGuarantee === "" || !Number.isFinite(guaranteed)) return null;
    return {
      type,
      basis_points: Math.round(value * 100),
      fixed_amount_minor: Math.round(guaranteed * 100),
      base,
    };
  }
  return { type, basis_points: Math.round(value * 100), base };
}
