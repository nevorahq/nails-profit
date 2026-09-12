/**
 * The hours the calendar can still sell, roadmap section 7.2.
 *
 * Kept out of the component because it is the part with rules rather than
 * markup, and rules deserve tests that do not need a renderer.
 */

/**
 * An instant, read as the wall clock of a location.
 *
 * `toISOString().slice(11, 16)` is the tempting version and it is wrong: it
 * shows UTC, which is two or three hours off in Chișinău and would offer a
 * client a time the studio is shut.
 */
export function clockAt(instant: string, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(instant));
}

export type ShiftRule = Readonly<{
  specialistId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  /** Local dates: a rota change takes effect on a day, not at an instant. */
  effectiveFrom: string;
  /** Exclusive, so a handover leaves no gap. */
  effectiveTo: string | null;
}>;

export type Span = Readonly<{ start: number; end: number }>;

/** Whether a rota rule covers this date. Mirrors `ruleAppliesOn` in `domain/availability`. */
function shiftCovers(rule: ShiftRule, localDate: string, weekday: number): boolean {
  if (rule.weekday !== weekday) return false;
  if (localDate < rule.effectiveFrom) return false;
  return rule.effectiveTo === null || localDate < rule.effectiveTo;
}

/** Overlapping spans read as one. Two rules for one morning are one morning. */
function merge(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((left, right) => left.start - right.start);
  const merged: Span[] = [];

  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) {
      if (span.end > last.end) merged[merged.length - 1] = { start: last.start, end: span.end };
      continue;
    }
    merged.push({ ...span });
  }

  return merged;
}

/**
 * The hours a master could still sell today: their rota, less everything
 * already standing in it.
 *
 * Measured against the rota and against nothing else, which is the whole point.
 * Any fixed frame — the 08:00–20:00 the old timetable drew, or a whole calendar
 * day — would hand a master who works 10:00 to 16:00 far more free hours than
 * they have, and the studio would offer a client an hour nobody is in.
 *
 * `busy` arrives with the studio's buffers already added to each appointment.
 * A buffer is not free time — the booking engine will not place anything in it
 * — so leaving it out would offer the desk a ten-minute opening that the
 * product itself refuses to book.
 *
 * `minMinutes` is what separates a window from a crack. A gap shorter than the
 * shortest service on the price list cannot take a client whatever it looks
 * like, and counting it would make the tally over the day a number the studio
 * cannot act on.
 */
export function freeWindows(
  rota: readonly ShiftRule[],
  busy: readonly Span[],
  minMinutes: number,
): Span[] {
  const open = merge(rota.map((rule) => ({ start: rule.startMinute, end: rule.endMinute })));
  if (open.length === 0) return [];

  const taken = merge(busy);
  const free: Span[] = [];

  for (const shift of open) {
    let cursor = shift.start;

    for (const span of taken) {
      if (span.end <= cursor) continue;
      if (span.start >= shift.end) break;
      if (span.start > cursor) free.push({ start: cursor, end: Math.min(span.start, shift.end) });
      cursor = Math.max(cursor, span.end);
      if (cursor >= shift.end) break;
    }

    if (cursor < shift.end) free.push({ start: cursor, end: shift.end });
  }

  return free.filter((span) => span.end - span.start >= minMinutes);
}

/**
 * How long a set of spans lasts in total, overlaps counted once.
 *
 * Used for both halves of the tally: the rota a master works, and what is left
 * of it. Merging first is what keeps a split shift written as two overlapping
 * rules from being counted as more hours than there are in the morning.
 */
export function totalMinutes(spans: readonly Span[]): number {
  return merge(spans).reduce((sum, span) => sum + (span.end - span.start), 0);
}

/**
 * Hours, to the half, rounded down.
 *
 * Down because the remainder is not sellable: twenty minutes left at the end of
 * a shift is not half an hour of anything, and rounding it up would put a
 * figure over the day that promises the studio time it cannot fill. Halves
 * rather than whole hours because a 90-minute service leaves them constantly —
 * whole hours would report 6 for six and a half, every day, in one direction.
 */
export function toHalfHours(minutes: number): number {
  return Math.floor(minutes / 30) / 2;
}

/** The rota rules that apply to one specialist on one date. */
export function rotaFor(
  rules: readonly ShiftRule[],
  specialistId: string,
  localDate: string,
  weekday: number,
): ShiftRule[] {
  return rules.filter(
    (rule) => rule.specialistId === specialistId && shiftCovers(rule, localDate, weekday),
  );
}
