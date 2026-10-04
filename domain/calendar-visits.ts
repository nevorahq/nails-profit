/**
 * A visit closed by hand, as the staff calendar draws it.
 *
 * The calendar is made of appointments, and a visit recorded through «Закрыть
 * визит» without one used to be missing from it altogether: the day it
 * happened read «Записей нет» while `/app/visits` listed it. It is drawn among
 * the appointments now, on the hours it took.
 *
 * Only a visit with no appointment behind it. One closed from an appointment is
 * already on the calendar as that appointment, `completed`, and drawing it
 * twice would make one client look like two.
 */

export type ManualVisitTiming = Readonly<{
  completedAt: Date;
  plannedDurationMinutes: number;
  actualDurationMinutes: number | null;
}>;

/**
 * The hours a visit took: from its length before the close, to the close.
 *
 * A visit records when it was closed, not when it began — the close form
 * writes the moment it is sent, which is the end of the work. The length is
 * what the master said it actually took, else what the services were planned
 * at, the same order the costing reads it in.
 */
export function manualVisitSpan(visit: ManualVisitTiming): { startsAt: Date; endsAt: Date } {
  const minutes = Math.max(0, visit.actualDurationMinutes ?? visit.plannedDurationMinutes);
  return {
    startsAt: new Date(visit.completedAt.getTime() - minutes * 60_000),
    endsAt: visit.completedAt,
  };
}

export type CalendarVisitFilters = Readonly<{
  /** The address the calendar is narrowed to, or empty for all of them. */
  location: string;
  /** The statuses asked for, or none for all of them. */
  statuses: readonly string[];
}>;

/**
 * Whether the calendar's own filters keep a visit closed by hand.
 *
 * Master scope and the master filter are applied by the query, as they are to
 * appointments. Two filters have no column to read on a visit:
 *
 *   - status: such a visit is done, so it is what `completed` means for an
 *     appointment, and it goes wherever `completed` goes;
 *   - address: the visit records none, so it is kept for an address its master
 *     works at — a master who works at one address did the work there.
 */
export function keepsManualVisit(
  visit: Readonly<{ specialistLocationIds: readonly string[] }>,
  filters: CalendarVisitFilters,
): boolean {
  if (filters.statuses.length > 0 && !filters.statuses.includes("completed")) return false;
  if (filters.location !== "" && !visit.specialistLocationIds.includes(filters.location)) return false;
  return true;
}
