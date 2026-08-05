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

  // Nobody has anything today: one empty section, not a row of empty columns.
  if (present.length === 0) return [{ key: days[0], title: days[0], bookings: [] }];

  return present.map((person) => ({
    key: person.id,
    title: person.name,
    bookings: onThisDay.filter((booking) => booking.specialistId === person.id),
  }));
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
