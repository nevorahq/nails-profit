/**
 * Half-open intervals of time, `[start, end)`.
 *
 * Half-open is the same convention the rest of the product already uses for
 * commission rules (`active_from` inclusive, `active_to` exclusive) and the one
 * PostgreSQL's `tstzrange(…, '[)')` exclusion constraints will enforce in
 * section 7.5. It is also the only convention under which an appointment ending
 * at 10:00 and one starting at 10:00 do not overlap — which is what a salon
 * means when it books them back to back.
 */
export type Interval = Readonly<{ start: Date; end: Date }>;

export function isEmpty(interval: Interval) {
  return interval.end.getTime() <= interval.start.getTime();
}

export function overlaps(left: Interval, right: Interval) {
  return left.start.getTime() < right.end.getTime() && right.start.getTime() < left.end.getTime();
}

export function contains(outer: Interval, inner: Interval) {
  return outer.start.getTime() <= inner.start.getTime() && inner.end.getTime() <= outer.end.getTime();
}

function byStart(left: Interval, right: Interval) {
  return left.start.getTime() - right.start.getTime();
}

/** Sorted, non-overlapping, and touching pieces joined into one. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((interval) => !isEmpty(interval)).sort(byStart);
  const merged: Interval[] = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    // `<=` joins abutting intervals: 09:00–13:00 and 13:00–18:00 are one shift,
    // not two, and leaving them apart would put a phantom boundary in the
    // middle of the working day.
    if (last && interval.start.getTime() <= last.end.getTime()) {
      if (interval.end.getTime() > last.end.getTime()) {
        merged[merged.length - 1] = { start: last.start, end: interval.end };
      }
      continue;
    }
    merged.push(interval);
  }

  return merged;
}

/** What remains of `base` once every `cut` is removed. */
export function subtractIntervals(base: readonly Interval[], cuts: readonly Interval[]): Interval[] {
  const removals = mergeIntervals(cuts);
  let remaining = mergeIntervals(base);

  for (const cut of removals) {
    const next: Interval[] = [];
    for (const piece of remaining) {
      if (!overlaps(piece, cut)) {
        next.push(piece);
        continue;
      }
      // A cut through the middle leaves two pieces; through an edge, one.
      if (piece.start.getTime() < cut.start.getTime()) {
        next.push({ start: piece.start, end: cut.start });
      }
      if (cut.end.getTime() < piece.end.getTime()) {
        next.push({ start: cut.end, end: piece.end });
      }
    }
    remaining = next;
  }

  return remaining;
}

export function intersectIntervals(left: readonly Interval[], right: readonly Interval[]): Interval[] {
  const result: Interval[] = [];

  for (const a of mergeIntervals(left)) {
    for (const b of mergeIntervals(right)) {
      const start = Math.max(a.start.getTime(), b.start.getTime());
      const end = Math.min(a.end.getTime(), b.end.getTime());
      if (start < end) result.push({ start: new Date(start), end: new Date(end) });
    }
  }

  return mergeIntervals(result);
}

export function padInterval(interval: Interval, beforeMinutes: number, afterMinutes: number): Interval {
  return {
    start: new Date(interval.start.getTime() - beforeMinutes * 60_000),
    end: new Date(interval.end.getTime() + afterMinutes * 60_000),
  };
}

export function durationMinutes(interval: Interval) {
  return (interval.end.getTime() - interval.start.getTime()) / 60_000;
}
