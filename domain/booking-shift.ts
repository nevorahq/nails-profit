import { contains, type Interval } from "@/domain/interval";

/**
 * Moving the rest of a master's day when one visit ran short or long.
 *
 * Pure, like the availability engine beside it: the caller loads the bookings
 * and the working hours and passes them in, which is what lets every refusal be
 * tested without a database.
 *
 * The two directions are not mirror images, and the asymmetry is the point.
 *
 *   - Earlier moves only what is back to back. A booking with a gap before it
 *     was placed at that hour on purpose — a lunch, a client who asked for it —
 *     and pulling it forward would undo that. So the chain stops at the first
 *     gap, and everything in it keeps its spacing.
 *   - Later moves only what the delay actually runs into. A ten minute gap
 *     absorbs ten minutes of a fifteen minute delay, and the chain stops at the
 *     first booking that was not touched, because nothing after it is either.
 */
export type ShiftBooking = Readonly<{ id: string; start: Date; end: Date }>;

export type ShiftMove = Readonly<{
  id: string;
  from: Interval;
  to: Interval;
}>;

export type ShiftRefusal =
  /**
   * The first booking would start in the past, or the visit before it would be
   * left having ended before it began: more time was freed than it was booked for.
   */
  | Readonly<{ reason: "too_early"; bookingId: string }>
  /** A booking would end up outside the hours the master works. */
  | Readonly<{ reason: "outside_working_hours"; bookingId: string }>
  /** Nothing follows, or the delay fits inside the gap. */
  | Readonly<{ reason: "nothing_to_move" }>;

export type ShiftPlan =
  | Readonly<{ ok: true; moves: readonly ShiftMove[] }>
  | (Readonly<{ ok: false }> & ShiftRefusal);

export type ShiftInput = Readonly<{
  /** The bookings after the visit that ran short or long, in start order. */
  following: readonly ShiftBooking[];
  /** Minutes, negative for earlier. Whole minutes; zero is refused as nothing to move. */
  deltaMinutes: number;
  /**
   * When the visit before them ends *after* the change: its booked end plus the
   * delta. Later, it is what the first booking is pushed against.
   */
  anchorEnd: Date;
  /** When that visit began, which it cannot have ended before. */
  anchorStart: Date;
  /** The earliest instant anything may be moved to. Earlier shifts must not reach into the past. */
  notBefore: Date;
  /** The master's working time after exceptions, as instants. */
  working: readonly Interval[];
}>;

const MINUTE = 60_000;

/** Whether an interval sits inside one stretch of working time. */
function isWorked(working: readonly Interval[], interval: Interval) {
  return working.some((span) => contains(span, interval));
}

export function planShift(input: ShiftInput): ShiftPlan {
  const { following, deltaMinutes, anchorEnd, anchorStart, notBefore, working } = input;
  if (following.length === 0 || deltaMinutes === 0) return { ok: false, reason: "nothing_to_move" };

  const candidates: ShiftMove[] = [];

  if (deltaMinutes < 0) {
    const shift = deltaMinutes * MINUTE;
    let previousEnd: Date | null = null;

    for (const booking of following) {
      // Back to back, or the chain is over. The first booking always starts it.
      if (previousEnd !== null && booking.start.getTime() > previousEnd.getTime()) break;
      previousEnd = booking.end;

      candidates.push({
        id: booking.id,
        from: { start: booking.start, end: booking.end },
        to: {
          start: new Date(booking.start.getTime() + shift),
          end: new Date(booking.end.getTime() + shift),
        },
      });
    }

    const first = candidates[0]!;
    if (anchorEnd.getTime() < anchorStart.getTime() || first.to.start.getTime() < notBefore.getTime()) {
      return { ok: false, reason: "too_early", bookingId: first.id };
    }
  } else {
    let pushedUntil = anchorEnd.getTime();

    for (const booking of following) {
      // The delay has been absorbed by a gap: this booking is untouched, and so
      // is everything behind it.
      if (booking.start.getTime() >= pushedUntil) break;

      const length = booking.end.getTime() - booking.start.getTime();
      const start = new Date(pushedUntil);
      const end = new Date(pushedUntil + length);
      pushedUntil = end.getTime();

      candidates.push({
        id: booking.id,
        from: { start: booking.start, end: booking.end },
        to: { start, end },
      });
    }
  }

  if (candidates.length === 0) return { ok: false, reason: "nothing_to_move" };

  for (const move of candidates) {
    // A booking somebody already placed outside the rota is not made worse by
    // moving it, so it is not refused for it. The rule protects the hours the
    // master works, not hours the studio had already overridden.
    if (isWorked(working, move.to) || !isWorked(working, move.from)) continue;
    return { ok: false, reason: "outside_working_hours", bookingId: move.id };
  }

  return { ok: true, moves: candidates };
}

/**
 * The order the moves have to be written in, so that no booking is written onto
 * the hour of one that has not moved yet.
 *
 * Earlier: nearest first, each landing on time its neighbour has just left.
 * Later: furthest first, for the same reason in the other direction. The
 * database refuses an overlap statement by statement, so the order is not a
 * tidiness — the wrong one fails a plan that is valid as a whole.
 */
export function shiftWriteOrder<T extends ShiftMove>(moves: readonly T[], deltaMinutes: number): T[] {
  return deltaMinutes < 0 ? [...moves] : [...moves].reverse();
}
