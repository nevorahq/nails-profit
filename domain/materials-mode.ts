/**
 * How a studio counts what its materials cost, month by month.
 *
 * Two answers, and a studio picks one per month from a date onwards:
 *
 *   - `purchases`: what was bought is what is subtracted, in the month it was
 *     bought — gel, files, gloves as ordinary costs of the month. This is how
 *     every studio has counted since the material engine was removed, and it
 *     needs nothing typed per service. It is coarse: a crate bought in March is
 *     March's, however long it lasts.
 *   - `per_service`: each service and add-on carries an amount of materials it
 *     uses up, taken off the visit's margin when it closes. The purchases are
 *     then money leaving the account, not a second cost — counting both would
 *     subtract every pot of gel twice.
 *
 * The mode is a history rather than a setting, because it decides how a month
 * is costed and a month already reported must not be re-costed by a change made
 * later. A change therefore takes effect from the first day of a month, never
 * one already begun earlier than the current month, and the months before keep
 * whatever mode they were in.
 */

export const materialsCostingModes = ["purchases", "per_service"] as const;
export type MaterialsCostingMode = (typeof materialsCostingModes)[number];

/** What a studio that never chose counts by: every studio, before this existed. */
export const DEFAULT_MATERIALS_MODE: MaterialsCostingMode = "purchases";

export type MaterialsModePeriod = Readonly<{
  mode: MaterialsCostingMode;
  /** `YYYY-MM-DD`, always the first of a month. */
  effectiveFrom: string;
}>;

/**
 * The mode a month was counted in: the latest change on or before it.
 *
 * `month` is `YYYY-MM`. String order is date order for both shapes, which is
 * the whole comparison.
 */
export function materialsModeFor(
  periods: readonly MaterialsModePeriod[],
  month: string,
): MaterialsCostingMode {
  let chosen: MaterialsModePeriod | null = null;
  for (const period of periods) {
    if (period.effectiveFrom.slice(0, 7) > month) continue;
    if (!chosen || period.effectiveFrom > chosen.effectiveFrom) chosen = period;
  }
  return chosen?.mode ?? DEFAULT_MATERIALS_MODE;
}

/**
 * Whether materials typed on services matter now or in a month already
 * scheduled — which is when the field on a service is worth showing. A studio
 * switching from next month fills the amounts in before it starts.
 */
export function usesPerServiceMaterials(
  periods: readonly MaterialsModePeriod[],
  currentMonth: string,
): boolean {
  return (
    materialsModeFor(periods, currentMonth) === "per_service" ||
    periods.some((period) => period.effectiveFrom.slice(0, 7) > currentMonth && period.mode === "per_service")
  );
}
