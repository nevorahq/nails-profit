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
 * A day is grouped by specialist, a week by day, and the list not at all.
 *
 * The day view is the one a studio keeps open, and the question it answers is
 * "who is with whom, and when is each of them free" — a question about one
 * person's column rather than about the hour. A week is the opposite: which day
 * has room. Only specialists who actually have something appear, because a
 * column per specialist all saying the same nothing is not information.
 */
export function groupBookings<T extends GroupableBooking>(
  view: CalendarView,
  days: readonly string[],
  bookings: readonly T[],
  specialists: readonly Readonly<{ id: string; name: string }>[],
): CalendarGroup<T>[] {
  if (view === "list") {
    return [{ key: "all", title: `${days[0]} — ${days.at(-1)}`, bookings: [...bookings] }];
  }

  if (view === "week") {
    return days.map((day) => ({
      key: day,
      title: day,
      bookings: bookings.filter((booking) => booking.localDate === day),
    }));
  }

  const onThisDay = bookings.filter((booking) => booking.localDate === days[0]);
  const present = specialists.filter((person) =>
    onThisDay.some((booking) => booking.specialistId === person.id),
  );

  /*
   * And whoever else this day is booked with, even when they no longer work
   * here.
   *
   * The roster the columns are drawn from is the live one, and it has to be —
   * a column for every master who ever left would grow forever. The
   * appointments are deliberately not filtered that way, because a client's
   * Tuesday does not disappear because the studio parted with somebody. Read
   * together, those two right answers made a third, wrong one: an archived
   * master's appointments were in the data and had no column to sit in, so the
   * day a studio looks at after letting somebody go was the one day that did
   * not show what still had to be moved.
   *
   * Named from the booking, which carries the name precisely because the
   * catalogue may no longer answer for it.
   */
  const orphaned = [
    ...new Map(
      onThisDay
        .filter((booking) => !specialists.some((person) => person.id === booking.specialistId))
        .map((booking) => [booking.specialistId, booking]),
    ).values(),
  ];

  // Nobody has anything today: one empty section, not a row of empty columns.
  if (present.length === 0 && orphaned.length === 0) {
    return [{ key: days[0], title: days[0], bookings: [] }];
  }

  return [
    ...present.map((person) => ({
      key: person.id,
      title: person.name,
      bookings: onThisDay.filter((booking) => booking.specialistId === person.id),
    })),
    ...orphaned.map((booking) => ({
      key: booking.specialistId,
      title: booking.specialistName ?? "",
      bookings: onThisDay.filter((other) => other.specialistId === booking.specialistId),
    })),
  ];
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
