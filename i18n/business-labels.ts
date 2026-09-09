import type { MessageKey } from "@/i18n/t";

/**
 * The wording that differs between a studio and someone working alone.
 *
 * `organization.type` decides **nothing** about money. Every figure in
 * `domain/period-pl.ts` is computed the same way for both, and switching the
 * type recomputes no history and changes no total — see
 * `docs/cost-engine-redesign-plan.md`, section 4. What it changes is whether
 * the report says «Оплата труда мастеров» to a woman who has no masters.
 *
 * Listed as a table rather than assembled from a template. `t()` takes a
 * `MessageKey`, and a key built at runtime would have to be cast — which is
 * exactly the check that stops a Romanian pilot from meeting a blank label.
 * Here a missing translation is a compile error, and the whole set of places
 * where the two shapes of business diverge is one screen long and reviewable.
 *
 * Keep it that way. A label belongs here only when the other variant would be
 * wrong, not merely less pleasant: every entry is a sentence that has to be
 * written twice and translated three times forever.
 */
export type BusinessType = "solo" | "studio";

export const businessTypes = ["solo", "studio"] as const;

export const businessLabel = {
  /** «Оплата труда мастеров» has no referent when there are no masters. */
  labour: { solo: "pl.labour.solo", studio: "pl.labour.studio" },
  /** The owner reading it about themselves is the owner reading «его труда». */
  principalAddBack: {
    solo: "pl.principalAddBack.solo",
    studio: "pl.principalAddBack.studio",
  },
  operatingProfitHint: {
    solo: "pl.operatingProfitHint.solo",
    studio: "pl.operatingProfitHint.studio",
  },
  principalHint: { solo: "pl.principalHint.solo", studio: "pl.principalHint.studio" },
  /** «Труда владельца» is a stranger's wage to a woman reading about her own. */
  ownerWage: { solo: "pl.ownerWage.solo", studio: "pl.ownerWage.studio" },
  /** The second break-even target, which is that same wage in a sentence. */
  breakEvenWithWage: {
    solo: "capacity.breakEvenWithWage.solo",
    studio: "capacity.breakEvenWithWage.studio",
  },
  /** The column of the ranking that names who did the work. */
  masterEarnings: {
    solo: "dashboard.masterEarnings.solo",
    studio: "dashboard.masterEarnings.studio",
  },
  /*
   * The service card's three lines, which are one sentence: price, minus what
   * the work costs, equals what is left.
   *
   * «Комиссия мастера» and «Останется вам» are both wrong for a woman working
   * alone, and wrong in opposite directions — the first calls her own pay
   * somebody else's, the second calls what is left after it hers, when it is
   * the business's share above her hour. The month's report already adds the
   * commission of a principal back below the margin; this is the same fact
   * said on the screen where prices are actually set.
   */
  serviceCommission: { solo: "services.commission.solo", studio: "services.commission.studio" },
  /** The same word again, lowercase, inside «Как это посчитано». */
  serviceCommissionWord: {
    solo: "services.commissionWord.solo",
    studio: "services.commissionWord.studio",
  },
  serviceKept: { solo: "services.youKeep.solo", studio: "services.youKeep.studio" },
  /*
   * The first step of «Первый расчёт», in all four places it is written.
   *
   * It is the only step of the three that diverges, and it is the first screen
   * an account ever sees: «Добавьте мастера» greets a woman who works alone
   * with a form for hiring somebody who does not exist. The other two steps —
   * a priced service, a closed visit — are the same job whoever is reading.
   */
  stepGoalSpecialist: {
    solo: "step.goal.specialist.solo",
    studio: "step.goal.specialist.studio",
  },
  stepActionSpecialist: {
    solo: "step.action.specialist.solo",
    studio: "step.action.specialist.studio",
  },
  onboardingSpecialist: {
    solo: "onboarding.specialist.solo",
    studio: "onboarding.specialist.studio",
  },
  onboardingSpecialistHint: {
    solo: "onboarding.specialistHint.solo",
    studio: "onboarding.specialistHint.studio",
  },
  /**
   * What the commission on a visit adds up to, in the totals under the list of
   * visits and in the preview before one is closed. «Заработок мастера» is the
   * money leaving the business in a studio and the money staying in it for
   * somebody working alone — the same sum, read the opposite way round.
   */
  visitEarnings: { solo: "visits.masterEarnings.solo", studio: "visits.masterEarnings.studio" },
  /*
   * The paragraph over «Оплата труда за месяц», which opens by naming the two
   * arrangements the form collects.
   *
   * For a studio that is right: a salaried master and the owner's own hour are
   * the same mechanism seen from two sides, and the sentence is what stops an
   * owner paying for the same work twice. For a woman working alone there is
   * no salaried master, and the paragraph spends its first clause explaining a
   * distinction against something that does not exist — before the form below
   * it, which for her has one arrangement in it and no «Кому» to choose.
   */
  laborHint: { solo: "labor.hint.solo", studio: "labor.hint.studio" },
} as const satisfies Readonly<Record<string, Readonly<Record<BusinessType, MessageKey>>>>;

export type BusinessLabel = keyof typeof businessLabel;

export function isBusinessType(value: string): value is BusinessType {
  return (businessTypes as readonly string[]).includes(value);
}
