/**
 * «Пора позвать»: which clients are past their own rhythm, roadmap phase 8.
 *
 * A client's rhythm is their own, not the studio's: one comes every two weeks,
 * another every six, and a single threshold would either nag the first or miss
 * the second. So the interval is the median gap between their visits — a median
 * rather than a mean, because one summer away should not make every later
 * absence look normal — and a client is due once a week of slack past it has
 * gone by with nothing booked.
 *
 * Counted in the studio's local days. Two services closed as two visits on one
 * afternoon are one visit to the client, and a gap of zero days would drag the
 * median down to «comes daily».
 */

/**
 * Where the message the server writes leaves room for the booking page's
 * address, which only the browser knows the host of.
 *
 * Here rather than beside the panel that fills it in: a constant exported from
 * a `"use client"` module reaches a Server Component as a client reference, not
 * as its value, and the first live run put the text of a function into a
 * message to a client.
 */
export const BOOKING_LINK_TOKEN = "__BOOKING_LINK__";

/** The slack past a client's own interval before they are worth a message. */
export const RETURN_GRACE_DAYS = 7;

export type ReturnVisit = Readonly<{
  /** The studio-local date of the visit, `YYYY-MM-DD`. */
  day: string;
  /** When it was closed: orders two visits of one day. */
  completedAt: Date;
  specialistId: string;
}>;

export type ReturnInput = Readonly<{
  visits: readonly ReturnVisit[];
  /** The studio-local date today, `YYYY-MM-DD`. */
  today: string;
  /** Any booking still to come, with anyone: the client is already returning. */
  hasFutureBooking: boolean;
  archived: boolean;
  /**
   * A Master's own list: only clients whose latest visit was with them, so
   * two masters do not write to one client and a client who moved to a
   * colleague does not surface as lost. Undefined for the whole studio.
   */
  viewerSpecialistId?: string;
}>;

export type ReturnDue = Readonly<{
  lastVisitDay: string;
  /** The median gap between visits, in days. */
  intervalDays: number;
  daysSinceLastVisit: number;
  /** Days past the interval; at least `RETURN_GRACE_DAYS + 1` when due. */
  overdueDays: number;
  lastSpecialistId: string;
}>;

const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, date) / DAY_MS);
}

/** The middle gap, the mean of the two middle ones for an even count, rounded. */
export function medianDays(gaps: readonly number[]): number {
  const sorted = [...gaps].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** The client's place on the list, or null when they are not due. */
export function returnDue(input: ReturnInput): ReturnDue | null {
  if (input.archived || input.hasFutureBooking) return null;

  const ordered = [...input.visits].sort(
    (left, right) => left.completedAt.getTime() - right.completedAt.getTime(),
  );
  const last = ordered.at(-1);
  if (!last) return null;
  if (input.viewerSpecialistId !== undefined && last.specialistId !== input.viewerSpecialistId) {
    return null;
  }

  const days = [...new Set(ordered.map((visit) => dayNumber(visit.day)))].sort((a, b) => a - b);
  // One visit is no rhythm yet: there is nothing to be late against.
  if (days.length < 2) return null;

  const gaps = days.slice(1).map((day, index) => day - days[index]);
  const intervalDays = medianDays(gaps);
  const daysSinceLastVisit = dayNumber(input.today) - days.at(-1)!;
  const overdueDays = daysSinceLastVisit - intervalDays;
  if (overdueDays <= RETURN_GRACE_DAYS) return null;

  return {
    lastVisitDay: last.day,
    intervalDays,
    daysSinceLastVisit,
    overdueDays,
    lastSpecialistId: last.specialistId,
  };
}
