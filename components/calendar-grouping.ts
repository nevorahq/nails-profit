/**
 * How the calendar arranges what it was given, roadmap section 7.2.
 *
 * Kept out of the component because it is the part with rules rather than
 * markup, and rules deserve tests that do not need a renderer.
 */
export type CalendarView = "day" | "week" | "list";

export type GroupableBooking = Readonly<{
  id: string;
  localDate: string;
  specialistId: string;
  /** Whose it is, for the day a column has to be drawn for somebody archived. */
  specialistName?: string;
}>;

export type CalendarGroup<T> = Readonly<{ key: string; title: string; bookings: T[] }>;

/**
 * A column per specialist, for the two views whose question is "whose is this".
 *
 * Only specialists who actually have something appear: a column per specialist
 * all saying the same nothing is not information.
 *
 * And whoever else is booked here, even when they no longer work at the studio.
 * The roster the columns are drawn from is the live one, and it has to be — a
 * column for every master who ever left would grow forever. The appointments
 * are deliberately not filtered that way, because a client's Tuesday does not
 * disappear because the studio parted with somebody. Read together, those two
 * right answers made a third, wrong one: an archived master's appointments were
 * in the data and had no column to sit in, so the day a studio looks at after
 * letting somebody go was the one day that did not show what still had to be
 * moved. Named from the booking, which carries the name precisely because the
 * catalogue may no longer answer for it.
 */
function bySpecialist<T extends GroupableBooking>(
  scoped: readonly T[],
  specialists: readonly Readonly<{ id: string; name: string }>[],
): CalendarGroup<T>[] {
  const present = specialists.filter((person) =>
    scoped.some((booking) => booking.specialistId === person.id),
  );

  const orphaned = [
    ...new Map(
      scoped
        .filter((booking) => !specialists.some((person) => person.id === booking.specialistId))
        .map((booking) => [booking.specialistId, booking]),
    ).values(),
  ];

  return [
    ...present.map((person) => ({
      key: person.id,
      title: person.name,
      bookings: scoped.filter((booking) => booking.specialistId === person.id),
    })),
    ...orphaned.map((booking) => ({
      key: booking.specialistId,
      title: booking.specialistName ?? "",
      bookings: scoped.filter((other) => other.specialistId === booking.specialistId),
    })),
  ];
}

/**
 * A day and a list are grouped by specialist, a week by day.
 *
 * The day view is the one a studio keeps open, and the question it answers is
 * "who is with whom, and when is each of them free" — a question about one
 * person's column rather than about the hour. A week is the opposite: which day
 * has room.
 *
 * The list used to be the exception, handed back whole: every master's
 * appointments in one run, ordered by time, with a client's Thursday sitting
 * between two of somebody else's. It answers the same question the day does —
 * whose is this — over a longer window, so it is grouped the same way. What it
 * does not get is the day's timetable: a fortnight cannot be laid out against
 * one column of hours.
 */
export function groupBookings<T extends GroupableBooking>(
  view: CalendarView,
  days: readonly string[],
  bookings: readonly T[],
  specialists: readonly Readonly<{ id: string; name: string }>[],
): CalendarGroup<T>[] {
  if (view === "list") {
    const columns = bySpecialist(bookings, specialists);
    // Nothing in the whole window: one panel saying so, headed by the dates it
    // covers, rather than a row of columns for people with nothing in them.
    return columns.length > 0
      ? columns
      : [{ key: "all", title: `${days[0]} — ${days.at(-1)}`, bookings: [] }];
  }

  if (view === "week") {
    return days.map((day) => ({
      key: day,
      title: day,
      bookings: bookings.filter((booking) => booking.localDate === day),
    }));
  }

  const onThisDay = bookings.filter((booking) => booking.localDate === days[0]);
  const columns = bySpecialist(onThisDay, specialists);

  // Nobody has anything today: one empty section, not a row of empty columns.
  return columns.length > 0 ? columns : [{ key: days[0], title: days[0], bookings: [] }];
}

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
 * Measured against the rota rather than against the grid, which is the whole
 * point. The grid is 08:00–20:00 for everybody (`DEFAULT_GRID`), so counting
 * empty pixels would hand a master who works 10:00–16:00 eleven free hours and
 * paint their morning yellow.
 *
 * `busy` arrives with the studio's buffers already added to each appointment.
 * A buffer is not free time — the booking engine will not place anything in it
 * — so leaving it out would offer the desk a ten-minute opening that the
 * product itself refuses to book.
 *
 * `minMinutes` is what separates a window from a crack. A gap shorter than the
 * shortest service on the price list cannot take a client whatever it looks
 * like, and counting it would make the tally in the column head a number the
 * studio cannot act on.
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
 * figure in the column head that promises the studio time it cannot fill. Halves
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
