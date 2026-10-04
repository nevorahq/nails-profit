/**
 * What the opening screen will not save: the terms a studio opens on.
 *
 * The screen exists so that no client books on a price or an hour nobody
 * chose, so the one thing it insists on is that a price was given — a service
 * at 0 would be a page offering free manicures, and a missing week would be a
 * page with nothing to book. Everything else (which kinds, how long) is the
 * owner's to decide and is only held to being a number.
 *
 * Shared by the screen, which says what is wrong before anything is sent, and
 * by the endpoint, which must refuse the same things from a caller that is not
 * the screen.
 */

export type OpeningService = Readonly<{ priceMinor: number; durationMinutes: number }>;

export type OpeningWeek = Readonly<{
  weekdays: readonly number[];
  /** Minutes after local midnight, or null for a time that did not parse. */
  startMinute: number | null;
  endMinute: number | null;
}>;

export type OpeningProblem = Readonly<{
  field: string;
  code: "none" | "price_required" | "duration_range" | "no_days" | "invalid_hours";
}>;

/** A day is at most this long, and a service longer than a day is a typo. */
export const MAX_SERVICE_MINUTES = 24 * 60;

export function openingSetupProblems(
  input: Readonly<{ services: readonly OpeningService[]; week?: OpeningWeek | null }>,
): OpeningProblem[] {
  const problems: OpeningProblem[] = [];

  if (input.services.length === 0) problems.push({ field: "services", code: "none" });
  input.services.forEach((service, index) => {
    if (!Number.isInteger(service.priceMinor) || service.priceMinor <= 0) {
      problems.push({ field: `services.${index}.price_minor`, code: "price_required" });
    }
    if (
      !Number.isInteger(service.durationMinutes) ||
      service.durationMinutes <= 0 ||
      service.durationMinutes > MAX_SERVICE_MINUTES
    ) {
      problems.push({ field: `services.${index}.duration_minutes`, code: "duration_range" });
    }
  });

  if (input.week) {
    if (input.week.weekdays.length === 0) problems.push({ field: "workweek.weekdays", code: "no_days" });
    const { startMinute, endMinute } = input.week;
    if (startMinute === null || endMinute === null || startMinute >= endMinute) {
      problems.push({ field: "workweek.hours", code: "invalid_hours" });
    }
  }

  return problems;
}
