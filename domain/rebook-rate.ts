/**
 * «Записались на следующий раз»: the share of visits that left with the next
 * one booked, roadmap phase 8.
 *
 * Measured per visit, the way salons measure it, and not as a share of all
 * appointments: that would rise and fall with how many clients happen to book
 * online, which nobody at the desk controls. This is the one a master moves
 * by asking «через три недели?» before the client stands up.
 *
 * Which visits count, decided 06.10.2026:
 *
 * - the denominator is visits closed from a calendar appointment with a client
 *   — only those carry «Следующая запись», and a visit recorded by hand should
 *   not pull the rate down for a button it never had;
 * - a visit counts as rebooked when an appointment booked from it was not
 *   cancelled. One cancelled the next morning is not a return; a no-show is —
 *   at the visit, the client did book.
 */

export type RebookVisit = Readonly<{
  /** The appointment the visit was closed from; the rebooking points at it. */
  bookingId: string;
}>;

export type Rebooking = Readonly<{
  rebookedFromBookingId: string;
  status: string;
}>;

export type RebookRate = Readonly<{
  /** Visits that could have booked the next one. */
  eligible: number;
  /** Of those, the ones that did and kept it. */
  rebooked: number;
  /** `rebooked / eligible` in basis points, rounded half away from zero; null with nothing to divide. */
  rateBasisPoints: number | null;
}>;

export function rebookRate(visits: readonly RebookVisit[], rebookings: readonly Rebooking[]): RebookRate {
  const kept = new Set(
    rebookings
      .filter((rebooking) => rebooking.status !== "cancelled")
      .map((rebooking) => rebooking.rebookedFromBookingId),
  );
  // One visit is one chance, however many appointments were made from it.
  const eligible = new Set(visits.map((visit) => visit.bookingId));
  const rebooked = [...eligible].filter((bookingId) => kept.has(bookingId)).length;

  return {
    eligible: eligible.size,
    rebooked,
    rateBasisPoints: eligible.size === 0 ? null : Math.round((rebooked * 10_000) / eligible.size),
  };
}

/**
 * The change against the previous period, in whole percentage points.
 *
 * Points rather than the relative change the money cards use: from 20% to 30%
 * is «+10 п.п.», and «+50%» would read as half the clients again.
 */
export function rebookRateDeltaPoints(current: RebookRate, previous: RebookRate | null): number | null {
  if (current.rateBasisPoints === null || previous?.rateBasisPoints == null) return null;
  return Math.round((current.rateBasisPoints - previous.rateBasisPoints) / 100);
}
