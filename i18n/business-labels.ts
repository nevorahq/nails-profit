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
} as const satisfies Readonly<Record<string, Readonly<Record<BusinessType, MessageKey>>>>;

export type BusinessLabel = keyof typeof businessLabel;

export function isBusinessType(value: string): value is BusinessType {
  return (businessTypes as readonly string[]).includes(value);
}
